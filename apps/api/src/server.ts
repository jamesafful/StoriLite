import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
// NOTE: We keep the plugin for parity, but CodeQL won’t “see” it.
// The explicit preHandler limiter below is what satisfies CodeQL.
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

// ------------------------------ Setup ---------------------------------------

if (ffmpegPath) {
  // @ts-ignore fluent-ffmpeg accepts string|null
  ffmpeg.setFfmpegPath(ffmpegPath);
}

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

const ID_REGEX = /^[a-f0-9]{16}$/;
function isValidId(id: string): boolean {
  return ID_REGEX.test(id);
}

function safeJoin(baseDir: string, targetPath: string): string {
  const resolved = path.resolve(baseDir, targetPath);
  const base = path.resolve(baseDir) + path.sep;
  if (!resolved.startsWith(base)) throw new Error('Path traversal attempt');
  return resolved;
}

function mustBeInsideVault(p: string): string | null {
  const resolved = path.resolve(p);
  const vaultRoot = path.resolve(VAULT) + path.sep;
  return resolved.startsWith(vaultRoot) ? resolved : null;
}

function uniquePath(dest: string): string {
  if (!fs.existsSync(dest)) return dest;
  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const name = path.basename(dest, ext);
  let i = 1;
  let cand = path.join(dir, `${name}(${i})${ext}`);
  while (fs.existsSync(cand)) {
    i++;
    cand = path.join(dir, `${name}(${i})${ext}`);
  }
  return cand;
}

// ----------------------- Explicit per-route limiter -------------------------
// Small, local, in-memory token bucket so CodeQL sees rate limiting on handlers.
// We still keep @fastify/rate-limit (defense-in-depth), but THIS is what removes
// the CodeQL “missing rate limiting” alerts.

type Bucket = { tokens: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function limiter(max: number, windowMs: number) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // Key per IP + route path
    const ip = (req.ip || req.socket?.remoteAddress || 'unknown').toString();
    const route = (req.routerPath || (req as any).routeOptions?.url || req.url);
    const key = `${ip}|${route}|${max}|${windowMs}`;

    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { tokens: max, resetAt: now + windowMs };
      buckets.set(key, b);
    }

    if (b.tokens <= 0) {
      const resetSecs = Math.max(0, Math.ceil((b.resetAt - now) / 1000));
      reply
        .header('x-ratelimit-limit', String(max))
        .header('x-ratelimit-remaining', '0')
        .header('x-ratelimit-reset', String(resetSecs))
        .code(429)
        .send({ error: 'too many requests' });
      return reply; // stop handler
    }

    b.tokens -= 1;
    const remaining = Math.max(0, b.tokens);
    const resetSecs = Math.max(0, Math.ceil((b.resetAt - now) / 1000));
    reply
      .header('x-ratelimit-limit', String(max))
      .header('x-ratelimit-remaining', String(remaining))
      .header('x-ratelimit-reset', String(resetSecs));
  };
}

// ------------------------------- Server -------------------------------------

async function main() {
  const app = Fastify({ logger: true, trustProxy: true });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyMultipart, {
    limits: { fileSize: 1024 * 1024 * 1024, files: 200 }, // 1GB / 200 files
  });
  await app.register(fastifyStatic, {
    root: path.join(VAULT),
    prefix: '/vault/',
    decorateReply: false,
  });
  // Keep plugin (optional with global: false); our preHandler limiter is authoritative.
  await app.register(rateLimit, { global: false });

  // ------------------------------ Routes ------------------------------------

  app.get(
    '/',
    {
      preHandler: [limiter(120, 60_000)],
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async () => ({ ok: true, name: 'StoriLite API', vault: VAULT })
  );

  app.get(
    '/api/health',
    {
      preHandler: [limiter(300, 60_000)],
      config: { rateLimit: { max: 300, timeWindow: 60_000 } },
    },
    async () => ({ ok: true, vault: VAULT })
  );

  // GET /api/assets?text=2025
  app.get(
    '/api/assets',
    {
      preHandler: [limiter(120, 60_000)],
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

  // GET /api/thumb/:id
  app.get(
    '/api/thumb/:id',
    {
      preHandler: [limiter(180, 60_000)],
      config: { rateLimit: { max: 180, timeWindow: 60_000 } },
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

  // GET /api/file/:id
  app.get(
    '/api/file/:id',
    {
      preHandler: [limiter(120, 60_000)],
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

      if (!row) return reply.code(404).send();
      const safe = mustBeInsideVault(row.vault_path);
      if (!safe || !fs.existsSync(safe)) return reply.code(404).send();

      reply.header('Content-Type', row.media_type === 'image' ? 'image/avif' : 'video/mp4');
      return reply.send(fs.createReadStream(safe));
    }
  );

  // GET /api/backup/:id
  app.get(
    '/api/backup/:id',
    {
      preHandler: [limiter(60, 60_000)],
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
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

      const full = safeJoin(dir, files[0]);
      const lower = full.toLowerCase();
      const ctype =
        lower.endsWith('.png') ? 'image/png'
        : (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) ? 'image/jpeg'
        : lower.endsWith('.heic') ? 'image/heic'
        : 'application/octet-stream';

      reply.header('Content-Type', ctype);
      return reply.send(fs.createReadStream(full));
    }
  );

  // POST /api/upload
  app.post(
    '/api/upload',
    {
      preHandler: [limiter(60, 60_000)],
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      fs.mkdirSync(UPLOADS, { recursive: true });

      const parts = (req as any).parts();
      let count = 0;

      for await (const part of parts) {
        if (part.type === 'file' && part.filename) {
          const base = path.basename(part.filename).replace(/[^\w.\-]/g, '_');
          const dest = uniquePath(safeJoin(UPLOADS, base));

          req.log.info({ filename: path.basename(dest) }, 'upload: received');

          await new Promise<void>((res, rej) => {
            const ws = fs.createWriteStream(dest, { flags: 'wx' });
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
   * POST /api/compress  { preset?: 'standard'|'high'|'max' }
   */
  app.post(
    '/api/compress',
    {
      preHandler: [limiter(10, 60_000)],
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (req) => {
      const body = (req.body as any) || {};
      const preset: 'standard' | 'high' | 'max' = body.preset || 'standard';

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
            const qual = preset === 'max' ? 28 : preset === 'high' ? 45 : 35;
            const avif = await sharp(buf).avif({ quality: qual }).toBuffer();

            if (avif.length >= buf.length * 0.98) continue;

            const outDir = yymmDir(dirs.images, createdTs);
            const outPath = path.join(outDir, `${id}.avif`);
            fs.writeFileSync(outPath, avif);

            const thumb = await makeThumb(buf);
            fs.writeFileSync(path.join(dirs.thumbs, `${id}.webp`), thumb);

            const ex: any = await extractExif(buf);
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

            const year = new Date(ex?.createdTs ?? createdTs).getFullYear();
            const base = path.basename(file).toLowerCase();
            db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, String(year));
            db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, base);
            if (ex?.make)  db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, String(ex.make).toLowerCase());
            if (ex?.model) db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, String(ex.model).toLowerCase());

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
