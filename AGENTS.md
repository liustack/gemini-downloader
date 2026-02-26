# banana-downloader Project Context

## Project Overview
This is a Chrome extension for batch-downloading full-resolution images generated in Google Gemini conversations.
The UI is rendered as an in-page Shadow DOM panel on Gemini pages, not in a popup page.

## Tech Stack
- Runtime: Chrome Extension Manifest V3
- Build: Vite 6.4 + `@crxjs/vite-plugin` 2.3
- Language: TypeScript 5.9
- Package Manager: pnpm

## Core Features
1. Image detection: scan and detect Gemini-generated images on `gemini.google.com`, excluding user-uploaded reference images
2. In-page panel: click extension icon to toggle panel, with select all / unselect all and filename prefix input
3. Batch download: intercept Gemini native download flow via simulated click + fetch patch, then process through background for watermark removal and save
4. Download suppression: background cancels duplicate native blob: downloads via `chrome.downloads.onCreated` during batch flow

## Architecture (3-layer)

| Layer | File | Runtime | Role |
|-------|------|---------|------|
| Interceptor | `public/download-interceptor.js` | Main World | Patch `window.fetch` to capture original image blobs from Gemini download redirect chain |
| Content Script | `src/content/index.ts` | Isolated World | UI panel + orchestrate download flow (find button → click → wait for blob → send to background) |
| Background | `src/background/index.ts` | Service Worker | Watermark removal + file save + native download suppression |

## Communication
- Action Click → Background → Content Script (`TOGGLE_PANEL` / `OPEN_PANEL`)
- Content Script → Background (`DOWNLOAD_IMAGE` with dataUrl + filename)
- Content Script → Background (`SUPPRESS_DOWNLOADS` on/off)
- Main World → Content Script (`GBD_IMAGE_CAPTURED` via `window.postMessage`)

## Key Implementation Notes
- Display URLs (`/gg/`) and download URLs (`/gg-dl/`) use completely different signed tokens — `=s0` suffix rewriting does NOT work
- Original images are obtained by simulated-clicking the native "Download full size" button, which triggers Gemini's own RPC + redirect chain
- Image blobs are intercepted in main world via patched `window.fetch`, then sent to content script via `postMessage`
- `chrome.downloads.onCreated` in background suppresses duplicate native blob: downloads during batch flow
- Watermark removal is performed in background before saving
- Scan logic skips the extension's own Shadow DOM and excludes `user-query-file-preview` / `user-query-file-carousel` containers

## Development Workflow
1. Install: `pnpm install`
2. Dev: `pnpm dev`
3. Build: `pnpm build`
4. Load: load `dist/` in `chrome://extensions`

## Project Rules
- Use `pnpm`
- Keep Manifest V3 compatible
- Keep the panel dark-themed and visually aligned with Gemini


## Operational Docs (docs/)

1. All operational docs use front-matter metadata (`summary`, `read_when`).
2. Before creating a new doc, run `pnpm docs:list` to review the existing index.
3. Before starting work, check `read_when` hints and read relevant docs as needed.
4. For architecture decisions, see `docs/download-interception-architecture.md`.
