const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const ytSearch = require('yt-search');
const ffmpeg = require('fluent-ffmpeg');

// Bulut sunucularda FFmpeg'in sorunsuz çalışması için otomatik yükleyici
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());

// 1. UYKU MODU ENGELLEYİCİ (Ping Rotası)
// UptimeRobot buraya her 10 dakikada bir istek atıp sunucuyu uyanık tutacak.
app.get('/ping', (req, res) => {
    res.status(200).send('Sunucu ayakta ve çalışıyor!');
});

// 2. ARAMA MOTORU ROTASI
// Ön yüzden gelen kelimeyi aratıp JSON olarak başlık ve ID döndürür.
app.get('/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(400).json({ error: "Lütfen bir arama kelimesi girin." });

        const searchResults = await ytSearch(query);
        const videos = searchResults.videos.slice(0, 10).map(v => ({
            id: v.videoId,
            title: v.title,
            thumbnail: v.thumbnail,
            duration: v.timestamp
        }));

        res.json(videos);
    } catch (error) {
        console.error("Arama Hatası:", error);
        res.status(500).json({ error: "Arama sırasında bir hata oluştu." });
    }
});

// 3. DÖNÜŞTÜRME VE İNDİRME ROTASI (Asıl Büyü)
// Verilen ID'yi alır, sadece sesini çeker, MP3'e çevirir ve telefona yollar.
app.get('/process', async (req, res) => {
    try {
        const videoId = req.query.id;
        if (!videoId) return res.status(400).json({ error: "Video ID gerekli." });

        const url = `https://www.youtube.com/watch?v=${videoId}`;
        
        // Videonun bilgilerini al (Dosya adını belirlemek için)
        const info = await ytdl.getInfo(videoId);
        const title = info.videoDetails.title.replace(/[^\w\s]/gi, ''); // Özel karakterleri temizle

        res.header('Content-Disposition', `attachment; filename="${title}.mp3"`);
        res.header('Content-Type', 'audio/mpeg');

        // ytdl-core ile sadece sesi çek
        const stream = ytdl(url, { quality: 'highestaudio' });

        // FFmpeg ile sesi anında 320kbps MP3'e çevir ve istemciye (telefona) aktar
        ffmpeg(stream)
            .audioBitrate(320)
            .format('mp3')
            .on('error', (err) => {
                console.error('Dönüştürme Hatası:', err);
            })
            .pipe(res);

    } catch (error) {
        console.error("İşlem Hatası:", error);
        if (!res.headersSent) res.status(500).json({ error: "İndirme sırasında bir hata oluştu." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Motor çalıştı! Sunucu ${PORT} portunda dinleniyor.`);
});
        
