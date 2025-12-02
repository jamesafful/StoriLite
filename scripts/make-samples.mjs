import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';

const outDir = path.resolve('samples');
fs.mkdirSync(outDir, { recursive: true });

// 5 JPEGs + 1 PNG
const mkImage = async (name, color) => {
  const buf = await sharp({
    create: { width: 1024, height: 768, channels: 3, background: color }
  }).jpeg({ quality: 82 }).toBuffer();
  fs.writeFileSync(path.join(outDir, name), buf);
};

await mkImage('photo-1.jpg', '#f87171');  // red-ish
await mkImage('photo-2.jpg', '#60a5fa');  // blue-ish
await mkImage('photo-3.jpg', '#34d399');  // green-ish
await mkImage('photo-4.jpg', '#fbbf24');  // amber
await mkImage('photo-5.jpg', '#a78bfa');  // purple

// PNG
const png = await sharp({
  create: { width: 800, height: 600, channels: 3, background: '#111827' }
}).png().toBuffer();
fs.writeFileSync(path.join(outDir, 'ui-shot.png'), png);

// 2-second MP4 test pattern (if ffmpeg is available)
if (ffmpegPath) {
  console.log('Creating sample video with ffmpeg:', ffmpegPath);
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, [
      '-f','lavfi','-i','testsrc=size=640x360:rate=30',
      '-t','2',
      '-pix_fmt','yuv420p',
      path.join(outDir, 'clip.mp4')
    ], { stdio: 'inherit' });
    p.on('exit', code => code === 0 ? resolve() : reject(new Error('ffmpeg failed')));
  });
} else {
  console.log('ffmpeg-static not found; skipping video.');
}

console.log('Done. Samples in', outDir);
