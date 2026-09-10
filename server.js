const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 50 * 1024 * 1024 } });

// ВАЖНО: имена полей должны точно совпадать с тем, что шлёт n8n
const LAYER_FIELDS = ['fon', 'topleft', 'inscription', 'animal', 'item', 'transport', 'niz-pravo'];
const uploadFields = upload.fields([
  ...LAYER_FIELDS.map((name) => ({ name, maxCount: 1 })),
  { name: 'payload', maxCount: 1 }, // payload может прийти как поле-файл или как текст — примем оба
]);

app.get('/', (_req, res) => res.send('ok'));

app.post('/render', uploadFields, async (req, res) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
  const cleanup = () => fs.rmSync(work, { recursive: true, force: true });

  try {
    // payload может прийти либо в body (form field), либо как файл
    let payload = {};
    if (req.body && req.body.payload) {
      payload = JSON.parse(req.body.payload);
    } else if (req.files && req.files.payload && req.files.payload[0]) {
      payload = JSON.parse(fs.readFileSync(req.files.payload[0].path, 'utf8'));
    }

    // Собираем пути к загруженным слоям
    const files = {};
    for (const name of LAYER_FIELDS) {
      if (req.files && req.files[name] && req.files[name][0]) {
        files[name] = req.files[name][0].path;
      }
    }
    if (!files.fon) {
      return res.status(400).json({ error: 'Missing required layer: fon' });
    }

    const duration = Number(payload.duration) || 13;
    const out = path.join(work, 'out.mp4');

    // Порядок наложения: фон -> остальные слои поверх
    const overlayOrder = ['transport', 'animal', 'item', 'niz-pravo', 'inscription', 'topleft'];
    const present = overlayOrder.filter((n) => files[n]);

    // Входы ffmpeg: 0 = фон, далее слои
    const inputs = ['-loop', '1', '-i', files.fon];
    present.forEach((n) => inputs.push('-loop', '1', '-i', files[n]));

    // Фильтр: масштабируем фон в 1080x1920, накладываем слои по центру
    let filter = '[0:v]scale=1080:1920,setsar=1[bg];';
    let last = 'bg';
    present.forEach((n, i) => {
      const idx = i + 1;
      filter += `[${idx}:v]scale=1080:1920:force_original_aspect_ratio=decrease[l${idx}];`;
      const next = i === present.length - 1 ? 'vout' : `t${idx}`;
      filter += `[${last}][l${idx}]overlay=(W-w)/2:(H-h)/2[${next}];`;
      last = next;
    });

    const args = [
      '-y',
      ...inputs,
      '-filter_complex', filter,
      '-map', '[vout]',
      '-t', String(duration),
      '-r', '30',
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      out,
    ];

    execFile('ffmpeg', args, { maxBuffer: 1024 * 1024 * 64 }, (err, _stdout, stderr) => {
      if (err) {
        cleanup();
        return res.status(500).json({ error: 'ffmpeg failed', details: String(stderr).slice(-2000) });
      }
      const filename = `quiz_${crypto.randomBytes(4).toString('hex')}.mp4`;
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      const stream = fs.createReadStream(out);
      stream.pipe(res);
      stream.on('close', cleanup);
      stream.on('error', cleanup);
    });
  } catch (e) {
    cleanup();
    res.status(500).json({ error: 'render error', details: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`render server on :${PORT}`));
