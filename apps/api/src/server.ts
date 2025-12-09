import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
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

// Configure ffmpeg if available
if (ffmpegPath) {
  // @ts-ignore fluent-ffmpeg path setter accepts string | null
  ffmpeg.setFfmpegPath(ffmpegPath);
}

// Resolve vault directory (prefer VAULT_DIR, fall back to repo root .vault if present)
let VAULT = process.env.VAULT_DIR || path.resolve('.vault');
const rootVault = path.resolve(process.cwd(), '../../.vault');
if (!fs.existsSync(VAULT) && fs.existsSync(rootVault)) {
  VAULT = rootVault;
}

const PORT = Number(process.env.PORT || 8787);
const UPLOADS = path.resolve('.uploads');

// ------------------------------ Utilities -----------------------------------

function isImage(file: string) {
  return /\.(jpe?g|png|webp|heic|avif)$/i.test(file);
}
function isVideo(file: string) {
  return /\.(mp4|mov|m4v)$/i.test(file);
}

// Asset IDs are 16-char lowercase hex (as produced by idFromBuffer(..))
const ID_REGEX = /^[a-f0-9]{16}$/;
function isValidId(id: string): boolean {
  return ID_REGEX.test(id);
}

// Prevent directory traversal; ensures result stays within baseDir.
function safeJoin(baseDir: string, targetPath: string): string {
  const resolved = path.resolve(baseDir, targetPath);
  const base = path.resolve(baseDir) + path.sep;
  if (!resolved.startsWith(base)) {
    throw new Error('Path traversal attempt');
  }
  return resolved;
}

// ------------------------------- Server -------------------------------------

async function main() {
  // trustProxy: true ensures correct client IP when behind Codespaces/NGINX/etc.
  const app = Fastify({ logger: true, trustProxy: true });

  await app.register(fastifyCors, { origin: true }); // tighten in production
  await app.register(fastifyMultipart, {
    limits: { fileSize: 1024 * 1024 * 1024, files: 200 }, // 1GB / 200 files
  });
  await app.register(fastifyStatic, {
    root: path.join(VAULT),
    prefix: '/vault/',
    decorateReply: false,
  });
  // We’ll use per-route limits (CodeQL prefers explicit limits on each handler)
  await app.register(rateLimit, { global: false });

  // ------------------------------ Routes ------------------------------------

  // GET /
  app.get(
    '/',
    {
      config: { rateLimit: { max: 120, timeWindow: 60_000 } }, // 120/min
    },
    async () => ({ ok: true, name: 'StoriLite API', vault: VAULT })
  );

  // GET /api/health
  app.get(
    '/api/health',
    {
      config: { rateLimit: { max: 300, timeWindow: 60_000 } }, // health can be higher
    },
    async () => ({ ok: true, vault: VAULT })
  );

  /** GET /api/assets?text=2025 */
  app.get(
    '/api/assets',
    {
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (req) => {
      const { text } = (req.query as { text?: string }) || {};
      const db = ensureDb(VAULT);
      const rows = simpleQuery(db, { text: text || undefined });

      return rows.map((r: any) => ({
        id: r.id,
        media_type: r.media_type,
        created_ts: r.created_ts,
        vault_path: r.vault_path,
        bytes_orig: r.bytes_orig,
        bytes_vault: r.bytes_vault,
        saved_bytes: Math.max(0, (r.bytes_orig ?? 0) - (r.bytes_vault ?? 0)),
      }));
    }
  );

  /** GET /api/thumb/:id → webp thumbnail */
  app.get(
    '/api/thumb/:id',
    {
      config: { rateLimit: { max: 180, timeWindow: 60_000 } }, // thumbs can be hit by gallery views
    },
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      const id = String(req.params.id || '');
      if (!isValidId(id)) return reply.code(400).send({ error: 'invalid id' });

      const p = safeJoin(path.join(VAULT, 'thumbs'), `${id}.webp`);
      if (!fs.existsSync(p)) return reply.code(404).send();

      reply.header('Content-Type', 'image/webp');
      return reply.send(fs.createReadStream(p));
    }
  );

  /** GET /api/file/:id → optimized AVIF/MP4 stream */
  app.get(
    '/api/file/:id',
    {
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      const id = String(req.params.id || '');
      if (!isValidId(id)) return reply.code(400).send({ error: 'invalid id' });

      const db = ensureDb(VAULT);
      const row = db
        .prepare('SELECT vault_path, media_type FROM asset WHERE id=?')
        .get(id) as { vault_path: string; media_type: 'image' | 'video' } | undefined;

      if (!row || !fs.existsSync(row.vault_path)) return reply.code(404).send();

      reply.header(
        'Content-Type',
        row.media_type === 'image' ? 'image/avif' : 'video/mp4'
      );
      return reply.send(fs.createReadStream(row.vault_path));
    }
  );

  /** Optional: GET /api/backup/:id → original file stream if present */
  app.get(
    '/api/backup/:id',
    {
      config: { rateLimit: { max: 60, timeWindow: 60_000 } }, // lower; original fetches are rarer
    },
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      const id = String(req.params.id || '');
      if (!isValidId(id)) return reply.code(400).send({ error: 'invalid id' });

      const dir = safeJoin(path.join(VAULT, 'backups'), id);
      if (!fs.existsSync(dir)) return reply.code(404).send();

      const files = fs.readdirSync(dir);
      if (!files.length) return reply.code(404).send();

      // Serve the first entry inside the safe backup dir (no user-controlled path)
      const full = safeJoin(dir, files[0]);
      const lower = full.toLowerCase();
      const ctype =
        lower.endsWith('.png')
          ? 'image/png'
          : lower.endsWith('.jpg') || lower.endsWith('.jpeg')
          ? 'image/jpeg'
          : lower.endsWith('.heic')
          ? 'image/heic'
          : 'application/octet-stream';

      reply.header('Content-Type', ctype);
      return reply.send(fs.createReadStream(full));
    }
  );

  /** POST /api/upload (multipart) → stores files into .uploads/ */
  app.post(
    '/api/upload',
    {
      config: {
        rateLimit: { max: 60, timeWindow: 60_000 }, // 60/min
      },
    },
    async (req, reply) => {
      fs.mkdirSync(UPLOADS, { recursive: true });

      const parts = (req as any).parts();
      let count = 0;

      for await (const part of parts) {
        if (part.type === 'file' && part.filename) {
          // Sanitize filename to a safe basename; strip unsafe chars.
          const base = path.basename(part.filename).replace(/[^\w.\-]/g, '_');
          const dest = safeJoin(UPLOADS, base);

          req.log.info({ filename: base }, 'upload: received');

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
      return reply.send({ ok: true, uploaded: count });
    }
  );

  /**
   * POST /api/compress { preset?: 'standard'|'high'|'max' }
   * Imports from .uploads into the vault (images → AVIF, videos → MP4).
   */
  app.post(
    '/api/compress',
    {
      config: {
        rateLimit: { max: 10, timeWindow: 60_000 }, // 10/min
      },
    },
    async (req) => {
      const body = (req.body as any) || {};
      const preset: 'standard' | 'high' | 'max' = body.preset || 'standard';

      const db = ensureDb(VAULT);
      const dirs = ensureVaultLayout(VAULT);

      const files = await fg(['**/*.*'], {
        cwd: UPLOADS,
        absolute: true,
        dot: false,
      });
      req.log.info({ files: files.length }, 'compress: found files');

      let converted = 0;

      for (const file of files) {
        try {
          const buf = fs.readFileSync(file);
          const id = idFromBuffer(buf); // 16-char hex ID
          const stat = fs.statSync(file);
          const createdTs = stat.mtimeMs;

          if (isImage(file)) {
            const qual = preset === 'max' ? 28 : preset === 'high' ? 45 : 35;
            const avif = await sharp(buf).avif({ quality: qual }).toBuffer();

            // Skip tiny conversions (savings < 2%)
            if (avif.length >= buf.length * 0.98) {
              continue;
            }

            const outDir = yymmDir(dirs.images, createdTs);
            const outPath = path.join(outDir, `${id}.avif`);
            fs.writeFileSync(outPath, avif);

            const thumb = await makeThumb(buf);
            fs.writeFileSync(path.join(dirs.thumbs, `${id}.webp`), thumb);

            const ex: any = await extractExif(buf); // loosen typing to include make/model
            db.prepare(
              `INSERT OR REPLACE INTO asset
               (id, orig_path, vault_path, media_type, created_ts, bytes_orig, bytes_vault, quality_preset, state)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              id,
              file,
              outPath,
              'image',
              ex?.createdTs ?? createdTs,
              buf.length,
              avif.length,
              preset,
              'verified'
            );

            // Index terms: year + filename + camera make/model (when present)
            const year = new Date(ex?.createdTs ?? createdTs).getFullYear();
            const base = path.basename(file).toLowerCase();
            db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, String(year));
            db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, base);
            if (ex?.make)
              db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, String(ex.make).toLowerCase());
            if (ex?.model)
              db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, String(ex.model).toLowerCase());

            converted++;
          } else if (isVideo(file)) {
            const outDir = yymmDir(dirs.videos, createdTs);
            const outPath = path.join(outDir, `${id}.mp4`);

            await new Promise<void>((resolve, reject) => {
              ffmpeg(file)
                .videoCodec('libx264')
                .outputOptions(['-crf 23', '-preset veryfast'])
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
            ).run(
              id,
              file,
              outPath,
              'video',
              createdTs,
              fs.statSync(file).size,
              av.size,
              preset,
              'verified'
            );

            const base = path.basename(file).toLowerCase();
            db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, String(new Date(createdTs).getFullYear()));
            db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, base);

            converted++;
          }
        } catch (e) {
          (req as any).log.error(e);
        }
      }

      // Cleanup staged files so repeat compress doesn't reprocess the same ones
      try {
        for (const f of files) fs.rmSync(f, { force: true });
      } catch {}

      return { ok: true, converted };
    }
  );

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`API on http://localhost:${PORT} (vault=${VAULT})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
