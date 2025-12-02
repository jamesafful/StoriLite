import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { ensureDb } from '@photovault/core/dist/db.js';
import { simpleQuery } from '@photovault/core/dist/query.js';

const VAULT = process.env.VAULT_DIR || path.resolve('.vault');
const PORT = Number(process.env.PORT || 8787);

const app = Fastify({ logger: true });

// CORS for local dev
await app.register(fastifyCors, { origin: true });

// Optionally expose optimized files directly under /files (read-only)
await app.register(fastifyStatic, {
  root: path.join(VAULT),
  prefix: '/vault/',
  decorateReply: false
});

/**
 * GET /api/assets?text=2025
 */
app.get('/api/assets', async (req, reply) => {
  const url = new URL((req as any).raw.url!, `http://${(req as any).headers.host}`);
  const text = url.searchParams.get('text') || undefined;
  const db = ensureDb(VAULT);
  const rows = simpleQuery(db, { text });
  return rows.map((r: any) => ({
    id: r.id,
    media_type: r.media_type,
    created_ts: r.created_ts,
    vault_path: r.vault_path
  }));
});

/**
 * GET /api/thumb/:id  -> image/webp thumbnail
 */
app.get('/api/thumb/:id', async (req, reply) => {
  const id = (req.params as any).id;
  const p = path.join(VAULT, 'thumbs', `${id}.webp`);
  if (!fs.existsSync(p)) return reply.code(404).send();
  reply.header('Content-Type', 'image/webp');
  return reply.send(fs.createReadStream(p));
});

/**
 * GET /api/file/:id  -> optimized asset stream (AVIF/MP4)
 */
app.get('/api/file/:id', async (req, reply) => {
  const id = (req.params as any).id;
  const db = ensureDb(VAULT);
  const row = db.prepare('SELECT vault_path, media_type FROM asset WHERE id=?').get(id);
  if (!row || !fs.existsSync(row.vault_path)) return reply.code(404).send();
  reply.header('Content-Type', row.media_type === 'image' ? 'image/avif' : 'video/mp4');
  return reply.send(fs.createReadStream(row.vault_path));
});

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`API on http://localhost:${PORT} (vault=${VAULT})`);
});
