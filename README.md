# StoriLite

This is a **starter implementation** of the ai photo and video compression concept. 
It includes:
- **packages/core** — Vault, SQLite schema, EXIF indexing utilities (TypeScript)
- **packages/cli** — CLI to scan/compress a folder of photos/videos into an app-managed vault
- **apps/web** — React + Vite UI placeholder to browse results (demo-only)

> Currently, it aims to validate core flows in Codespaces.
> Image compression uses **sharp** (AVIF/WebP) and video transcode uses **ffmpeg-static** + **fluent-ffmpeg** if available on the platform.

## Quickstart (Codespaces)
1. Open in GitHub Codespaces (Node 20 recommended).
2. Enable pnpm: `corepack enable && corepack prepare pnpm@latest --activate`
3. Install deps: `pnpm install`
4. Initialize a vault (creates SQLite DB):
   ```bash
   pnpm cli init --vault .vault
   ```
5. Scan + compress a folder (JPEG/PNG/MP4/MOV):
   ```bash
   pnpm cli import --vault .vault --src ./samples
   ```
6. Start the web app (demo UI):
   ```bash
   pnpm --filter web dev
   ```

## Vault Layout
```
.vault/
  vault.db
  images/YY/MM/<id>.avif
  videos/YY/MM/<id>.mp4
  thumbs/<id>.webp
  backups/<id>/<original>
  meta/manifest.json
```

## Security Notes
- No media leaves your machine in this starter. Replace with production-grade encryption before shipping.

## License
No License. All rights reserved.