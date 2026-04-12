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

function getErrorDetails(error) {
  if (!error) {
    return 'Bilinmeyen hata';
  }
  return error.stack || error.message || String(error);
}

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

app.get('/process', async (req, res) => {
  const videoId = String(req.query.id || '').trim();
  const debugMode = req.query.debug === '1';
  if (!isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Gecerli bir video ID gerekli.' });
  }

  let ffmpegProcess = null;

  const abortWork = () => {
    if (ffmpegProcess && !ffmpegProcess.killed) {
      ffmpegProcess.kill();
    }
  };

  req.on('close', abortWork);
  res.on('close', abortWork);

  try {
    const { title, mediaUrl } = await getAudioSource(videoId);
    const fileName = sanitizeFileName(title);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', buildContentDisposition(fileName));
    res.setHeader('Cache-Control', 'no-store');

    ffmpegProcess = spawn(
      ffmpegPath,
      [
        '-v',
        'error',
        '-i',
        mediaUrl,
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

    let ffmpegError = '';

    ffmpegProcess.stderr.setEncoding('utf8');
    ffmpegProcess.stderr.on('data', (chunk) => {
      ffmpegError += chunk;
    });

    ffmpegProcess.on('error', (error) => {
      console.error('FFmpeg baslatma hatasi:', error);
      if (!res.headersSent) {
        const payload = { error: 'MP3 donusturme baslatilamadi.' };
        if (debugMode) payload.details = getErrorDetails(error);
        res.status(500).json(payload);
      } else {
        res.destroy(error);
      }
    });

    ffmpegProcess.on('close', (code) => {
      if (code === 0 || res.writableEnded) {
        return;
      }

      const message = ffmpegError.trim() || `FFmpeg cikis kodu ${code}`;
      console.error('FFmpeg donusturme hatasi:', message);

      if (!res.headersSent) {
        const payload = { error: 'MP3 donusturme basarisiz oldu.' };
        if (debugMode) payload.details = message;
        res.status(500).json(payload);
      } else {
        res.destroy(new Error(message));
      }
    });

    ffmpegProcess.stdout.pipe(res);
  } catch (error) {
    console.error('Indirme hatasi:', error);
    if (!res.headersSent) {
      const payload = { error: 'Indirme sirasinda bir hata olustu.' };
      if (debugMode) payload.details = getErrorDetails(error);
      res.status(500).json(payload);
    }
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

async function getAudioSource(videoId) {
  const ytDlpPath = await ensureYtDlpBinary();
  const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const { stdout } = await runCommand(
    ytDlpPath,
    [
      '-f',
      'bestaudio/best',
      '--no-playlist',
      '--no-warnings',
      '--print',
      'title',
      '--get-url',
      targetUrl,
    ],
    30000
  );

  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error('Ses kaynagi bulunamadi.');
  }

  const title = sanitizeFileName(lines[0]);
  const mediaUrl = lines[lines.length - 1];

  if (!/^https?:\/\//.test(mediaUrl)) {
    throw new Error('Gecerli bir medya baglantisi bulunamadi.');
  }

  return { title, mediaUrl };
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Motor calisti! Sunucu ${PORT} portunda dinleniyor.`);
});
