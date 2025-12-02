import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// We intentionally return `any` to avoid TS4058 ("type cannot be named")
// caused by better-sqlite3's exported types across ESM builds.
export function ensureDb(vaultDir: string): any {
  const dbPath = path.join(vaultDir, 'vault.db');
  if (!fs.existsSync(vaultDir)) fs.mkdirSync(vaultDir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS asset (
      id TEXT PRIMARY KEY,
      orig_path TEXT NOT NULL,
      vault_path TEXT,
      media_type TEXT NOT NULL,
      created_ts INTEGER,
      width INTEGER, height INTEGER,
      duration_ms INTEGER,
      exif_lat REAL, exif_lon REAL, exif_place TEXT,
      bytes_orig INTEGER, bytes_vault INTEGER,
      checksum_orig TEXT, checksum_vault TEXT,
      quality_preset TEXT,
      state TEXT
    );
    CREATE TABLE IF NOT EXISTS index_terms (
      asset_id TEXT,
      term TEXT
    );
  `);
  return db;
}
