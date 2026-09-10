// server.js — FFmpeg render server for Quiz Question Generator
const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const upload = multer({ dest: os.tmpdir() });

// ---------- Canvas ----------
const CANVAS_W = 900;
const CANVAS_H = 1600;
const DURATION = 13; // seconds

// ---------- Text layout (vertical centers on 1600px canvas) ----------
const QUESTION_CY = 529;                 // question block center
const ANSWER_CY   = [785, 890, 1011];    // answer A, B, C centers (C lowered +20px)

// ---------- Fonts ----------
const FONT_PATH = process.env.FONT_PATH || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const QUESTION_FONTSIZE = 46;
const ANSWER_FONTSIZE   = 44;
const QUESTION_COLOR = 'white';
const ANSWER_COLOR   = 'white';

// ---------- Layer order (bottom -> top) ----------
// fon is the video background; the rest are PNG overlays
const LAYERS = ['fon', 'topleft', 'inscription', 'animal', 'item', 'transport', 'niz-pravo'];

// Escape text for ffmpeg drawtext
function esc(t) {
  return String(t == null ? '' : t)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\n/g, ' ');
}

function drawText(text, cy, fontsize, color) {
  const t = esc(text);
  // horizontal centering: x=(w-text_w)/2
  return `drawtext=fontfile='${FONT_PATH}':text='${t}':fontcolor=${color}:fontsize=${fontsize}:` +
         `x=(w-text_w)/2:y=${cy}-(text_h/2):` +
         `borderw=4:bordercolor=black@0.85`;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/render', upload.any(), (req, res) => {
  const tmpFiles = [];
  try {
    // Map uploaded files by fieldname (layer name)
    const filesByLayer = {};
    for (const f of (req.files || [])) {
      filesByLayer[f.fieldname] = f.path;
      tmpFiles.push(f.path);
    }

    // Text payload (JSON fields)
    const question = req.body.question || '';
    let answers = [];
    try {
      answers = typeof req.body.answers === 'string'
        ? JSON.parse(req.body.answers)
        : (req.body.answers || []);
    } catch { answers = []; }

    // Verify fon (video background) present
    if (!filesByLayer['fon']) {
      return res.status(400).json({ error: 'MISSING_FON', message: 'fon (background video) is required' });
    }

    // ---------- Build ffmpeg inputs ----------
    const args = [];
    const inputLayers = LAYERS.filter(l => filesByLayer[l]);

    inputLayers.forEach((layer) => {
      if (layer === 'fon') {
        // Background video: loop it seamlessly for the whole duration
        args.push('-stream_loop', '-1', '-i', filesByLayer[layer]);
      } else {
        // PNG overlays: loop the still image
        args.push('-loop', '1', '-i', filesByLayer[layer]);
      }
    });

    // ---------- Build filter graph ----------
    // 1) scale fon to canvas
    // 2) overlay each PNG layer in order
    // 3) draw question + answer texts
    const filter = [];
    const fonIdx = inputLayers.indexOf('fon');

    filter.push(`[${fonIdx}:v]scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase,` +
                `crop=${CANVAS_W}:${CANVAS_H},setsar=1[base]`);

    let last = 'base';
    let step = 0;
    inputLayers.forEach((layer, idx) => {
      if (layer === 'fon') return;
      const outLbl = `ov${step}`;
      filter.push(`[${idx}:v]scale=${CANVAS_W}:${CANVAS_H}[l${idx}]`);
      filter.push(`[${last}][l${idx}]overlay=0:0:format=auto[${outLbl}]`);
      last = outLbl;
      step++;
    });

    // Draw texts on the last composited layer
    const draws = [];
    if (question) draws.push(drawText(question, QUESTION_CY, QUESTION_FONTSIZE, QUESTION_COLOR));
    (answers || []).slice(0, 3).forEach((ans, i) => {
      if (ANSWER_CY[i] != null) draws.push(drawText(ans, ANSWER_CY[i], ANSWER_FONTSIZE, ANSWER_COLOR));
    });

    if (draws.length) {
      filter.push(`[${last}]${draws.join(',')}[outv]`);
    } else {
      filter.push(`[${last}]null[outv]`);
    }

    const outPath = path.join(os.tmpdir(), `render_${Date.now()}.mp4`);
    tmpFiles.push(outPath);

    args.push(
      '-filter_complex', filter.join(';'),
      '-map', '[outv]',
      '-map', `${fonIdx}:a?`,   // take audio from the fon (background video), optional
      '-t', String(DURATION),
      '-r', '30',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      '-c:a', 'aac',            // encode audio
      '-b:a', '192k',
      '-shortest',              // stop at shortest stream (video duration)
      '-movflags', '+faststart',
      '-y', outPath
    );

    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });

    ff.on('close', (code) => {
      if (code !== 0) {
        cleanup(tmpFiles);
        return res.status(500).json({ error: 'FFMPEG_FAILED', exitCode: code, stderr: stderr.slice(-4000) });
      }
      res.setHeader('Content-Type', 'video/mp4');
      const stream = fs.createReadStream(outPath);
      stream.pipe(res);
      stream.on('close', () => cleanup(tmpFiles));
      stream.on('error', () => cleanup(tmpFiles));
    });

    ff.on('error', (err) => {
      cleanup(tmpFiles);
      res.status(500).json({ error: 'FFMPEG_SPAWN_FAILED', message: err.message });
    });

  } catch (err) {
    cleanup(tmpFiles);
    res.status(500).json({ error: 'RENDER_ERROR', message: err.message });
  }
});

function cleanup(files) {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch {}
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Render server listening on ${PORT}`));
