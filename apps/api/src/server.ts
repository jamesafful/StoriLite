import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import path from 'node:path';
import fs from 'node:fs';
import fg from 'fast-glob';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { ensureDb } from '@photovault/core/dist/db.js';
import { ensureVaultLayout, yymmDir, idFromBuffer } from '@photovault/core/dist/vault.js';
import { extractExif } from '@photovault/core/dist/exif.js';
import { simpleQuery } from '@photovault/core/dist/query.js';
import { makeThumb } from '@photovault/core/dist/thumbs.js';

if (ffmpegPath) {
  // @ts-ignore
  ffmpeg.setFfmpegPath(ffmpegPath);
}

let VAULT = process.env.VAULT_DIR || path.resolve('.vault');
const rootVault = path.resolve(process.cwd(), '../../.vault');
if (!fs.existsSync(VAULT) && fs.existsSync(rootVault)) {
  VAULT = rootVault;
}
const PORT = Number(process.env.PORT || 8787);
const UPLOADS = path.resolve('.uploads');

const app = Fastify({ logger: true });

await app.register(fastifyCors, { origin: true });
await app.register(fastifyMultipart, {
  limits: { fileSize: 1024 * 1024 * 1024, files: 200 } // 1GB / 200 files
});
await app.register(fastifyStatic, { root: path.join(VAULT), prefix: '/vault/', decorateReply: false });

// Friendly root (avoid 404 noise)
app.get('/', async () => ({ ok: true, name: 'StoriLite API', vault: VAULT }));
// Health check used by the web app splash
app.get('/api/health', async () => ({ ok: true, vault: VAULT }));

/** Helpers */
function isImage(file: string) { return /\.(jpe?g|png|webp|heic|avif)$/i.test(file); }
function isVideo(file: string) { return /\.(mp4|mov|m4v)$/i.test(file); }

/** GET /api/assets?text=2025 */
app.get('/api/assets', async (req, reply) => {
  const url = new URL((req as any).raw.url!, `http://${(req as any).headers.host}`);
  const text = url.searchParams.get('text') || undefined;
  const db = ensureDb(VAULT);
  const rows = simpleQuery(db, { text });
  return rows.map((r: any) => ({
    id: r.id,
    media_type: r.media_type,
    created_ts: r.created_ts,
    vault_path: r.vault_path,
    bytes_orig: r.bytes_orig,
    bytes_vault: r.bytes_vault,
    saved_bytes: Math.max(0, (r.bytes_orig ?? 0) - (r.bytes_vault ?? 0))
  }));
});

/** GET /api/thumb/:id → webp thumbnail */
app.get('/api/thumb/:id', async (req, reply) => {
  const id = (req.params as any).id;
  const p = path.join(VAULT, 'thumbs', `${id}.webp`);
  if (!fs.existsSync(p)) return reply.code(404).send();
  reply.header('Content-Type', 'image/webp');
  return reply.send(fs.createReadStream(p));
});

/** GET /api/file/:id → optimized AVIF/MP4 stream */
app.get('/api/file/:id', async (req, reply) => {
  const id = (req.params as any).id;
  const db = ensureDb(VAULT);
  const row = db.prepare('SELECT vault_path, media_type FROM asset WHERE id=?').get(id);
  if (!row || !fs.existsSync(row.vault_path)) return reply.code(404).send();
  reply.header('Content-Type', row.media_type === 'image' ? 'image/avif' : 'video/mp4');
  return reply.send(fs.createReadStream(row.vault_path));
});

/** Optional: GET /api/backup/:id → original file stream if present */
app.get('/api/backup/:id', async (req, reply) => {
  const id = (req.params as any).id;
  const dir = path.join(VAULT, 'backups', id);
  if (!fs.existsSync(dir)) return reply.code(404).send();
  const files = fs.readdirSync(dir);
  if (!files.length) return reply.code(404).send();
  const full = path.join(dir, files[0]);
  const lower = full.toLowerCase();
  const ctype =
    lower.endsWith('.png') ? 'image/png' :
    (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) ? 'image/jpeg' :
    lower.endsWith('.heic') ? 'image/heic' :
    'application/octet-stream';
  reply.header('Content-Type', ctype);
  return reply.send(fs.createReadStream(full));
});

/** POST /api/upload (multipart) → stores files into .uploads/ */
app.post('/api/upload', async (req, reply) => {
  fs.mkdirSync(UPLOADS, { recursive: true });
  const parts = req.parts();
  let count = 0;
  for await (const part of parts) {
    if (part.type === 'file' && part.filename) {
      req.log.info({ filename: part.filename }, 'upload: received');
      const dest = path.join(UPLOADS, part.filename);
      await new Promise<void>((res, rej) => {
        const ws = fs.createWriteStream(dest);
        part.file.pipe(ws);
        ws.on('finish', () => res());
        ws.on('error', rej);
      });
      count++;
    }
  }
  req.log.info({ uploaded: count }, 'upload: complete');
  return { ok: true, uploaded: count };
});

/** POST /api/compress { preset?: 'standard'|'high'|'max' } → imports from .uploads into vault */
app.post('/api/compress', async (req, reply) => {
  const body = (req.body as any) || {};
  const preset: 'standard'|'high'|'max' = body.preset || 'standard';
  const db = ensureDb(VAULT);
  const dirs = ensureVaultLayout(VAULT);
  const files = await fg(['**/*.*'], { cwd: UPLOADS, absolute: true, dot: false });
  req.log.info({ files: files.length }, 'compress: found files');

  let converted = 0;
  for (const file of files) {
    try {
      const buf = fs.readFileSync(file);
      const id = idFromBuffer(buf);
      const stat = fs.statSync(file);
      const createdTs = stat.mtimeMs;

      if (isImage(file)) {
        // Quality: tweak as desired (lower is higher quality for AVIF in sharp)
        const qual = preset === 'max' ? 28 : preset === 'high' ? 45 : 35;
        const avif = await sharp(buf).avif({ quality: qual }).toBuffer();

        // Skip tiny/pointless conversions (savings < 2%)
        if (avif.length >= buf.length * 0.98) {
          continue;
        }

        const outDir = yymmDir(dirs.images, createdTs);
        const outPath = path.join(outDir, `${id}.avif`);
        fs.writeFileSync(outPath, avif);

        const thumb = await makeThumb(buf);
        fs.writeFileSync(path.join(dirs.thumbs, `${id}.webp`), thumb);

        const ex = await extractExif(buf);
        db.prepare(
          `INSERT OR REPLACE INTO asset
           (id, orig_path, vault_path, media_type, created_ts, bytes_orig, bytes_vault, quality_preset, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, file, outPath, 'image', ex.createdTs ?? createdTs, buf.length, avif.length, preset, 'verified');

        // index terms: year + filename + camera make/model (when present)
        const year = new Date(ex.createdTs ?? createdTs).getFullYear();
        const base = path.basename(file).toLowerCase();
        db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, String(year));
        db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, base);
        if (ex?.make) db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, String(ex.make).toLowerCase());
        if (ex?.model) db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, String(ex.model).toLowerCase());

        converted++;
      } else if (isVideo(file)) {
        const outDir = yymmDir(dirs.videos, createdTs);
        const outPath = path.join(outDir, `${id}.mp4`);
        await new Promise<void>((resolve, reject) => {
          ffmpeg(file)
            .videoCodec('libx264')
            .outputOptions(['-crf 23','-preset veryfast'])
            .audioCodec('aac')
            .output(outPath)
            .on('end', () => resolve())
            .on('error', reject)
            .run();
        });
        const av = fs.statSync(outPath);
        db.prepare(
          `INSERT OR REPLACE INTO asset
           (id, orig_path, vault_path, media_type, created_ts, bytes_orig, bytes_vault, quality_preset, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, file, outPath, 'video', createdTs, fs.statSync(file).size, av.size, preset, 'verified');

        const base = path.basename(file).toLowerCase();
        db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, String(new Date(createdTs).getFullYear()));
        db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, base);
        converted++;
      }
    } catch (e) {
      req.log.error(e);
    }
  }

  // cleanup staged files so repeat compress doesn't reprocess the same ones
  try {
    for (const f of files) fs.rmSync(f, { force: true });
  } catch {}

  return { ok: true, converted };
});

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`API on http://localhost:${PORT} (vault=${VAULT})`);
});
