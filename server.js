const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const upload = multer({ dest: os.tmpdir() });

// Порядок и имена полей должны совпадать с тем, что шлёт n8n
const LAYER_FIELDS = ['fon', 'topleft', 'inscription', 'animal', 'item', 'transport', 'niz-pravo'];

app.post('/render', upload.any(), async (req, res) => {
  const files = {};
  for (const f of req.files) files[f.fieldname] = f.path;

  // payload — текстовое поле (напр. длительность, координаты и т.п.)
  let payload = {};
  try { payload = JSON.parse(req.body.payload || '{}'); } catch (e) {}

  const outPath = path.join(os.tmpdir(), `out_${Date.now()}.mp4`);

  // --- Собираем вход ffmpeg ---
  const inputs = [];
  const present = LAYER_FIELDS.filter((name) => files[name]);
  present.forEach((name) => {
    inputs.push('-loop', '1', '-i', files[name]);
  });

  // --- Собираем filter_complex как массив цепочек ---
  // fon (индекс 0) — база; остальные накладываем поверх через overlay
  const chains = [];
  let last = '[0:v]';

  // пример базовой нормализации фона
  chains.push(`${last}scale=1080:1920,setsar=1[base]`);
  last = '[base]';

  present.slice(1).forEach((name, i) => {
    const inIdx = i + 1;            // индекс входного файла
    const out = `[v${inIdx}]`;
    chains.push(`${last}[${inIdx}:v]overlay=0:0${out}`);
    last = out;
  });

  // join(';') гарантирует отсутствие хвостовой ';'
  const filter = chains.join(';');

  const args = [
    '-y',
    ...inputs,
    '-filter_complex', filter,
    '-map', last,
    '-t', String(payload.duration || 10),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    outPath,
  ];

  console.log('ffmpeg', args.join(' '));

  const ff = spawn('ffmpeg', args);
  let stderr = '';
  ff.stderr.on('data', (d) => { stderr += d.toString(); });

  ff.on('close', (code) => {
    // подчистка входных файлов
    Object.values(files).forEach((p) => fs.existsSync(p) && fs.unlinkSync(p));

    if (code !== 0) {
      console.error(stderr);
      fs.existsSync(outPath) && fs.unlinkSync(outPath);
      return res.status(500).json({ error: 'ffmpeg failed', detail: stderr.slice(-2000) });
    }

    res.sendFile(outPath, (err) => {
      fs.existsSync(outPath) && fs.unlinkSync(outPath);
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`render server on :${PORT}`));
