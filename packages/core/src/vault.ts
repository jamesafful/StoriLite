import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface VaultLayout {
  images: string;
  videos: string;
  thumbs: string;
  backups: string;
  meta: string;
}

export function ensureVaultLayout(vaultDir: string): VaultLayout {
  const dirs = {
    images: path.join(vaultDir, 'images'),
    videos: path.join(vaultDir, 'videos'),
    thumbs: path.join(vaultDir, 'thumbs'),
    backups: path.join(vaultDir, 'backups'),
    meta: path.join(vaultDir, 'meta')
  };
  Object.values(dirs).forEach(d => fs.mkdirSync(d, { recursive: true }));
  const manifest = path.join(dirs.meta, 'manifest.json');
  if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, JSON.stringify({ createdAt: Date.now() }, null, 2));
  return dirs;
}

export function yymmDir(base: string, ts: number) {
  const d = new Date(ts);
  const y = d.getFullYear().toString().slice(-2);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dir = path.join(base, `${y}`, m);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function idFromBuffer(buf: Buffer) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}
