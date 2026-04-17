const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const cors = require('cors');
const ytSearch = require('yt-search');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const app = express();

const YT_DLP_ASSET =
  process.platform === 'win32'
    ? 'yt-dlp.exe'
    : process.platform === 'darwin'
      ? 'yt-dlp_macos'
      : 'yt-dlp_linux';
const YT_DLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YT_DLP_ASSET}`;
const YT_DLP_PATH = path.join(os.tmpdir(), YT_DLP_ASSET);

let ytDlpReadyPromise = null;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/ping', (req, res) => {
  res.status(200).send('Sunucu ayakta ve calisiyor!');
});

app.get('/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) {
      return res.status(400).json({ error: 'Lutfen bir arama kelimesi girin.' });
    }

    const searchResults = await ytSearch(query);
    const videos = searchResults.videos.slice(0, 10).map((video) => ({
      id: video.videoId,
      title: video.title,
      thumbnail: video.thumbnail,
      duration: video.timestamp,
    }));

    res.json(videos);
  } catch (error) {
    console.error('Arama hatasi:', error);
    res.status(500).json({ error: 'Arama sirasinda bir hata olustu.' });
  }
});

app.get('/lyrics', async (req, res) => {
  try {
    const rawQuery = String(req.query.q || '').trim();
    if (!rawQuery) {
      return res.status(400).json({ error: 'Lutfen bir sarki ismi girin.' });
    }

    const lyrics = await resolveLyrics(rawQuery);
    if (!lyrics) {
      return res.status(404).json({ error: 'Sarki sozu bulunamadi.' });
    }

    res.json({ lyrics });
  } catch (error) {
    console.error('Soz arama hatasi:', error);
    res.status(500).json({ error: 'Sozler alinirken bir hata olustu.' });
  }
});

app.get('/process', async (req, res) => {
  const videoId = String(req.query.id || '').trim();
  const forceDownload = req.query.dl === '1' || req.query.download === '1';
  const debugMode = req.query.debug === '1';
  if (!isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Gecerli bir video ID gerekli.' });
  }

  let ytDlpProcess = null;
  let ffmpegProcess = null;
  let requestAborted = false;
  let responseFinished = false;
  let streamStarted = false;

  const abortWork = () => {
    if (ytDlpProcess && !ytDlpProcess.killed) {
      ytDlpProcess.kill();
    }
    if (ffmpegProcess && !ffmpegProcess.killed) {
      ffmpegProcess.kill();
    }
  };

  const failResponse = (error) => {
    if (responseFinished || requestAborted) {
      return;
    }

    responseFinished = true;
    console.error('Indirme hatasi:', error);
    abortWork();

    if (!res.headersSent) {
      const payload = { error: 'Indirme sirasinda bir hata olustu.' };
      if (debugMode) {
        payload.details = error && error.message ? error.message : String(error);
      }
      res.status(500).json(payload);
    } else if (!res.writableEnded) {
      res.destroy(new Error('Indirme sirasinda bir hata olustu.'));
    }
  };

  req.on('aborted', () => {
    requestAborted = true;
    abortWork();
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      requestAborted = true;
      abortWork();
    }
  });

  try {
    const ytDlpPath = await ensureYtDlpBinary();
    const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const title = await getVideoTitle(ytDlpPath, targetUrl);
    const fileName = sanitizeFileName(title);

    const startResponseStream = () => {
      if (streamStarted) {
        return;
      }

      streamStarted = true;
      res.setHeader('Content-Type', forceDownload ? 'application/octet-stream' : 'audio/mpeg');
      res.setHeader('Content-Disposition', buildContentDisposition(fileName));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    };

    ytDlpProcess = spawn(
      ytDlpPath,
      [
        '-f',
        'bestaudio/best',
        '--no-playlist',
        '--no-warnings',
        '--geo-bypass',
        '--extractor-args',
        'youtube:player_client=android,web_creator,web_safari',
        '-o',
        '-',
        targetUrl,
      ],
      { windowsHide: true }
    );

    ffmpegProcess = spawn(
      ffmpegPath,
      [
        '-v',
        'error',
        '-i',
        'pipe:0',
        '-vn',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        '-f',
        'mp3',
        'pipe:1',
      ],
      { windowsHide: true }
    );

    let ytDlpError = '';
    let ffmpegError = '';

    ytDlpProcess.stderr.setEncoding('utf8');
    ytDlpProcess.stderr.on('data', (chunk) => {
      ytDlpError += chunk;
    });

    ffmpegProcess.stderr.setEncoding('utf8');
    ffmpegProcess.stderr.on('data', (chunk) => {
      ffmpegError += chunk;
    });

    ytDlpProcess.on('error', (error) => {
      failResponse(error);
    });

    ffmpegProcess.on('error', (error) => {
      failResponse(error);
    });

    ytDlpProcess.stdout.pipe(ffmpegProcess.stdin);

    ytDlpProcess.on('close', (code) => {
      if (code === 0 || responseFinished || requestAborted) {
        return;
      }

      const message = ytDlpError.trim() || `yt-dlp cikis kodu ${code}`;
      failResponse(new Error(message));
    });

    ffmpegProcess.on('close', (code) => {
      if (code === 0 || res.writableEnded || responseFinished || requestAborted) {
        responseFinished = true;
        if (streamStarted && !res.writableEnded) {
          res.end();
        }
        return;
      }

      const message = ffmpegError.trim() || ytDlpError.trim() || `FFmpeg cikis kodu ${code}`;
      failResponse(new Error(message));
    });

    ffmpegProcess.stdout.once('data', (chunk) => {
      if (requestAborted || responseFinished) {
        return;
      }

      startResponseStream();
      res.write(chunk);
      ffmpegProcess.stdout.pipe(res);
    });
  } catch (error) {
    failResponse(error);
  }
});

function isValidVideoId(value) {
  return /^[A-Za-z0-9_-]{11}$/.test(value);
}

function sanitizeFileName(value) {
  return (
    (value || 'muzik')
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'muzik'
  );
}

function buildContentDisposition(fileName) {
  const asciiFallback = (fileName.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '').trim() || 'muzik') + '.mp3';
  const utfName = `${encodeURIComponent(fileName)}.mp3`;
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utfName}`;
}

function normalizeLyricsQuery(value) {
  return String(value || '')
    .replace(/\([^)]*(official|lyrics?|video|audio|hd|4k|live|clip)[^)]*\)/gi, ' ')
    .replace(/\[[^\]]*(official|lyrics?|video|audio|hd|4k|live|clip)[^\]]*\]/gi, ' ')
    .replace(/\b(official|lyrics?|video|audio|hd|4k|live|clip|music video)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitArtistAndTitle(query) {
  const cleaned = normalizeLyricsQuery(query);
  const parts = cleaned.split(/\s[-–—|]\s/).map((part) => part.trim()).filter(Boolean);

  if (parts.length >= 2) {
    return {
      artist: parts[0],
      title: parts.slice(1).join(' - '),
      cleaned,
    };
  }

  return { artist: '', title: cleaned, cleaned };
}

async function fetchJsonWithTimeout(url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function pickLrcLibLyrics(item) {
  if (!item || typeof item !== 'object') {
    return '';
  }
  const lyrics = String(item.plainLyrics || item.syncedLyrics || '').trim();
  return lyrics;
}

async function findLyricsFromLrcLib(title, artist) {
  const params = new URLSearchParams();
  params.set('track_name', title);
  if (artist) {
    params.set('artist_name', artist);
  }

  const data = await fetchJsonWithTimeout(`https://lrclib.net/api/search?${params.toString()}`, 12000, {
    'User-Agent': 'Mozilla/5.0',
  });

  if (!Array.isArray(data)) {
    return '';
  }

  for (const item of data) {
    const lyrics = pickLrcLibLyrics(item);
    if (lyrics) {
      return lyrics;
    }
  }
  return '';
}

async function findLyricsFromLyricsOvh(artist, title) {
  if (!artist || !title) {
    return '';
  }
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
  const data = await fetchJsonWithTimeout(url, 12000, { 'User-Agent': 'Mozilla/5.0' });
  const lyrics = String(data && data.lyrics ? data.lyrics : '').trim();
  return lyrics;
}

async function resolveLyrics(query) {
  const { artist, title, cleaned } = splitArtistAndTitle(query);
  if (!title) {
    return '';
  }

  const attempts = [];
  attempts.push({ title, artist });
  if (cleaned && cleaned !== title) {
    attempts.push({ title: cleaned, artist: '' });
  }
  if (!artist) {
    attempts.push({ title, artist: '' });
  }

  for (const attempt of attempts) {
    const fromLrcLib = await findLyricsFromLrcLib(attempt.title, attempt.artist);
    if (fromLrcLib) {
      return fromLrcLib;
    }
  }

  const fromLyricsOvh = await findLyricsFromLyricsOvh(artist, title);
  if (fromLyricsOvh) {
    return fromLyricsOvh;
  }

  return '';
}

async function ensureYtDlpBinary() {
  try {
    const stat = await fs.stat(YT_DLP_PATH);
    if (stat.size > 0) {
      return YT_DLP_PATH;
    }
  } catch (_) {
    // Missing binary is handled below.
  }

  if (!ytDlpReadyPromise) {
    ytDlpReadyPromise = (async () => {
      const response = await fetch(YT_DLP_URL, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      if (!response.ok) {
        throw new Error(`yt-dlp indirilemedi: HTTP ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(YT_DLP_PATH, buffer);

      if (process.platform !== 'win32') {
        await fs.chmod(YT_DLP_PATH, 0o755);
      }

      return YT_DLP_PATH;
    })().catch(async (error) => {
      ytDlpReadyPromise = null;
      try {
        await fs.unlink(YT_DLP_PATH);
      } catch (_) {
        // Ignore cleanup errors.
      }
      throw error;
    });
  }

  return ytDlpReadyPromise;
}

function runCommand(binaryPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Komut zaman asimina ugradi.'));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `Komut cikis kodu ${code}`));
      }
    });
  });
}

async function getVideoTitle(ytDlpPath, targetUrl) {
  const { stdout } = await runCommand(
    ytDlpPath,
    [
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      '--print',
      'title',
      targetUrl,
    ],
    45000
  );

  const title = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return title || 'muzik';
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Motor calisti! Sunucu ${PORT} portunda dinleniyor.`);
});
