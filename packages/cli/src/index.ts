#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { ensureDb } from '@photovault/core/dist/db.js';
import { ensureVaultLayout, yymmDir, idFromBuffer } from '@photovault/core/dist/vault.js';
import { extractExif } from '@photovault/core/dist/exif.js';
import { makeThumb } from '@photovault/core/dist/thumbs.js';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath as string);

function isImage(file: string) { return /\.(jpe?g|png|webp|heic|avif)$/i.test(file); }
function isVideo(file: string) { return /\.(mp4|mov|m4v)$/i.test(file); }

async function importFolder(vaultDir: string, src: string, preset: 'standard'|'high'|'max' = 'standard') {
  const db = ensureDb(vaultDir);
  const dirs = ensureVaultLayout(vaultDir);
  const files = await fg(['**/*.*'], { cwd: src, absolute: true, dot: false });
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
        const outDir = yymmDir(dirs.images, createdTs);
        const outPath = path.join(outDir, `${id}.avif`);
        fs.writeFileSync(outPath, avif);

        const thumb = await makeThumb(buf);
        fs.writeFileSync(path.join(dirs.thumbs, `${id}.webp`), thumb);

        const ex = await extractExif(buf);
        db.prepare(
          'INSERT OR REPLACE INTO asset (id, orig_path, vault_path, media_type, created_ts, bytes_orig, bytes_vault, quality_preset, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(id, file, outPath, 'image', ex.createdTs ?? createdTs, buf.length, avif.length, preset, 'verified');

        const year = new Date(ex.createdTs ?? createdTs).getFullYear();
        db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, String(year));
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
          'INSERT OR REPLACE INTO asset (id, orig_path, vault_path, media_type, created_ts, bytes_orig, bytes_vault, quality_preset, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(id, file, outPath, 'video', createdTs, fs.statSync(file).size, av.size, preset, 'verified');

        db.prepare('INSERT INTO index_terms (asset_id, term) VALUES (?, ?)').run(id, String(new Date(createdTs).getFullYear()));
      } else {
        continue;
      }

      // Save original as backup (no encryption in starter)
      const backupDir = path.join(dirs.backups, id);
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, path.basename(file)), buf);

      converted++;
      if (converted % 10 === 0) console.log(`Converted ${converted}/${files.length}`);
    } catch (e) {
      console.error('Failed:', file, e);
    }
  }
  console.log('Done. Converted:', converted);
}

function initVault(vaultDir: string) {
  ensureVaultLayout(vaultDir);
  ensureDb(vaultDir);
  console.log('Vault initialized at', vaultDir);
}

function queryVault(vaultDir: string, text?: string) {
  const db = ensureDb(vaultDir);
  const rows = text
    ? db.prepare(
        'SELECT a.* FROM asset a LEFT JOIN index_terms t ON a.id = t.asset_id WHERE t.term LIKE ? GROUP BY a.id LIMIT 200'
      ).all(`%${text}%`)
    : db.prepare('SELECT * FROM asset LIMIT 200').all();
  console.table(
    rows.map((r: any) => ({ id: r.id, type: r.media_type, bytes: r.bytes_vault, created: new Date(r.created_ts).toISOString() }))
  );
}

yargs(hideBin(process.argv))
  .scriptName('photovault')
  .command('init', 'Initialize a vault',
    (y) => y.option('vault', { type: 'string', demandOption: true }),
    (argv) => { initVault(argv.vault as string); }
  )
  .command('import', 'Import & compress a folder',
    (y) => y
      .option('vault', { type: 'string', demandOption: true })
      .option('src', { type: 'string', demandOption: true })
      .option('preset', { choices: ['standard','high','max'] as const, default: 'standard' }),
    (argv) => { importFolder(argv.vault as string, argv.src as string, argv.preset as any); }
  )
  .command('query', 'Query vault by simple term',
    (y) => y
      .option('vault', { type: 'string', demandOption: true })
      .option('text', { type: 'string' }),
    (argv) => { queryVault(argv.vault as string, argv.text as string|undefined); }
  )
  .demandCommand(1)
  .help()
  .parse();
