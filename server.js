const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

// ========================================
// ДИАГНОСТИКА
// Временно принимаем ЛЮБЫЕ file-поля
// ========================================
const uploadFields = upload.any();

app.get('/', (_req, res) => {
  res.send('ok');
});

app.post('/render', uploadFields, async (req, res) => {

  // ========================================
  // ПОКАЗЫВАЕМ, ЧТО ПРИСЛАЛ N8N
  // ========================================

  console.log('========================================');
  console.log('FILES FROM N8N:');

  if (req.files && req.files.length > 0) {
    console.log(
      req.files.map((file) => ({
        fieldname: file.fieldname,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        path: file.path
      }))
    );
  } else {
    console.log('NO FILES');
  }

  console.log('========================================');
  console.log('FIELD NAMES ONLY:');

  if (req.files) {
    console.log(req.files.map((file) => file.fieldname));
  }

  console.log('========================================');
  console.log('BODY:');
  console.log(req.body);

  console.log('========================================');


  // ========================================
  // РАБОЧАЯ ПАПКА
  // ========================================

  const work = fs.mkdtempSync(
    path.join(os.tmpdir(), 'render-')
  );

  const cleanup = () => {
    try {
      fs.rmSync(work, {
        recursive: true,
        force: true
      });
    } catch (e) {
      console.error('Cleanup error:', e.message);
    }
  };


  try {

    // ========================================
    // СОБИРАЕМ PAYLOAD
    // ========================================

    let payload = {};

    // payload как обычное текстовое поле
    if (req.body && req.body.payload) {

      console.log('PAYLOAD TYPE: text field');

      try {
        payload = JSON.parse(req.body.payload);
      } catch (e) {
        cleanup();

        return res.status(400).json({
          error: 'Invalid payload JSON',
          details: e.message
        });
      }

    } else {

      // payload как файл
      const payloadFile = req.files?.find(
        (file) => file.fieldname === 'payload'
      );

      if (payloadFile) {

        console.log('PAYLOAD TYPE: file');

        try {
          payload = JSON.parse(
            fs.readFileSync(payloadFile.path, 'utf8')
          );
        } catch (e) {
          cleanup();

          return res.status(400).json({
            error: 'Invalid payload JSON file',
            details: e.message
          });
        }

      } else {
        console.log('PAYLOAD: not found');
      }
    }


    // ========================================
    // РАЗРЕШЁННЫЕ СЛОИ
    // ========================================

    const LAYER_FIELDS = [
      'fon',
      'topleft',
      'inscription',
      'animal',
      'item',
      'transport',
      'niz-pravo'
    ];


    // ========================================
    // СОБИРАЕМ ФАЙЛЫ СЛОЁВ
    // ========================================

    const files = {};

    for (const name of LAYER_FIELDS) {

      const file = req.files?.find(
        (f) => f.fieldname === name
      );

      if (file) {
        files[name] = file.path;

        console.log(
          `FOUND LAYER: ${name} -> ${file.originalname}`
        );
      }
    }


    // ========================================
    // ПРОВЕРКА ФОНА
    // ========================================

    if (!files.fon) {

      cleanup();

      return res.status(400).json({
        error: 'Missing required layer: fon',

        received_fields: req.files
          ? req.files.map((f) => f.fieldname)
          : []
      });
    }


    // ========================================
    // DURATION
    // ========================================

    const duration =
      Number(payload.duration) || 13;


    console.log('DURATION:', duration);


    // ========================================
    // OUTPUT
    // ========================================

    const out = path.join(
      work,
      'out.mp4'
    );


    // ========================================
    // ПОРЯДОК НАЛОЖЕНИЯ
    // ========================================

    const overlayOrder = [
      'transport',
      'animal',
      'item',
      'niz-pravo',
      'inscription',
      'topleft'
    ];

    const present = overlayOrder.filter(
      (name) => files[name]
    );


    console.log('LAYERS FOUND:', present);


    // ========================================
    // INPUTS FFMPEG
    // ========================================

    const inputs = [
      '-loop',
      '1',
      '-i',
      files.fon
    ];

    present.forEach((name) => {

      inputs.push(
        '-loop',
        '1',
        '-i',
        files[name]
      );

    });


    // ========================================
    // FILTER COMPLEX
    // ========================================

    let filter =
      '[0:v]scale=1080:1920,setsar=1[bg];';


    let last = 'bg';


    present.forEach((name, i) => {

      const idx = i + 1;

      filter +=
        `[${idx}:v]scale=1080:1920:` +
        `force_original_aspect_ratio=decrease` +
        `[l${idx}];`;

      const next =
        i === present.length - 1
          ? 'vout'
          : `t${idx}`;

      filter +=
        `[${last}][l${idx}]` +
        `overlay=(W-w)/2:(H-h)/2` +
        `[${next}];`;

      last = next;

    });


    // ========================================
    // ЕСЛИ НЕТ НИ ОДНОГО СЛОЯ
    // ========================================

    if (present.length === 0) {

      filter =
        '[0:v]scale=1080:1920,setsar=1[vout];';

    }


    console.log('FFMPEG FILTER:');
    console.log(filter);


    // ========================================
    // FFMPEG ARGUMENTS
    // ========================================

    const args = [
      '-y',

      ...inputs,

      '-filter_complex',
      filter,

      '-map',
      '[vout]',

      '-t',
      String(duration),

      '-r',
      '30',

      '-pix_fmt',
      'yuv420p',

      '-c:v',
      'libx264',

      '-preset',
      'veryfast',

      out
    ];


    console.log('STARTING FFMPEG...');


    // ========================================
    // ЗАПУСК FFMPEG
    // ========================================

    execFile(
      'ffmpeg',
      args,
      {
        maxBuffer: 1024 * 1024 * 64
      },
      (err, _stdout, stderr) => {

        if (err) {

          console.error(
            'FFMPEG ERROR:',
            stderr
          );

          cleanup();

          return res.status(500).json({
            error: 'ffmpeg failed',
            details: String(stderr).slice(-2000)
          });
        }


        // ========================================
        // ИМЯ ФАЙЛА
        // ========================================

        const filename =
          `quiz_${crypto.randomBytes(4).toString('hex')}.mp4`;


        // ========================================
        // ОТДАЁМ MP4 В N8N
        // ========================================

        res.setHeader(
          'Content-Type',
          'video/mp4'
        );

        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${filename}"`
        );


        const stream =
          fs.createReadStream(out);


        stream.pipe(res);


        stream.on('close', cleanup);

        stream.on('error', (error) => {

          console.error(
            'STREAM ERROR:',
            error.message
          );

          cleanup();

        });

      }
    );


  } catch (e) {

    console.error(
      'RENDER ERROR:',
      e
    );

    cleanup();

    return res.status(500).json({
      error: 'render error',
      details: String(
        e.message || e
      )
    });

  }

});


// ========================================
// SERVER
// ========================================

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  () => {
    console.log(
      `render server on :${PORT}`
    );
  }
);
