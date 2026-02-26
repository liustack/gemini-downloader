# banana-downloader Project Context

## Project Overview
This is a Chrome extension that batch-downloads generated visual artifacts from:
- `gemini.google.com` (generated images)
- `notebooklm.google.com` (Infographic artifacts)

The UI is rendered as an in-page Shadow DOM panel, not in a popup page.

## Tech Stack
- Runtime: Chrome Extension Manifest V3
- Build: Vite 6.4 + `@crxjs/vite-plugin` 2.3
- Language: TypeScript 5.9
- Package Manager: pnpm

## Core Features
1. Multi-site adapter architecture (`Gemini` / `NotebookLM`) with host-based routing
2. In-page panel: click extension icon to toggle panel, select/unselect, set filename prefix
3. Gemini batch download:
   - simulate native "Download full size" click
   - intercept final image response in main world
   - send to background for watermark removal + save
4. NotebookLM batch download:
   - detect Infographic artifact entries
   - open artifact viewer, capture image URL
   - send URL to background for NotebookLM-specific watermark cleanup + save
5. Reliability strategy:
   - lazy-load preloading before scan/download
   - retry with scroll-container sweep for virtualized pages
   - capture-id based blob matching to avoid timeout mismatch
   - runtime message timeout guards
6. Native download suppression:
   - during Gemini batch flow, background cancels duplicate page-initiated `blob:` downloads

## Architecture

### Runtime Layers

| Layer | File | Runtime | Role |
|-------|------|---------|------|
| Interceptor | `public/download-interceptor.js` | Main World | Patch `window.fetch` for Gemini download chain; emit `GBD_IMAGE_CAPTURED` with `captureId` |
| Content Script | `src/content/index.ts` | Isolated World | Shared panel + adapter orchestration |
| Background | `src/background/index.ts` | Service Worker | Download processing, optional watermark removal, native blob suppression |

### Site Adapters

| Adapter | File | Runtime | Role |
|--------|------|---------|------|
| Gemini | `src/content/adapters/gemini.ts` | Isolated World | image detection + native button mapping + capture flow |
| NotebookLM | `src/content/adapters/notebooklm.ts` | Isolated World | infographic detection + viewer URL capture |
| Shared | `src/content/adapters/viewport.ts` | Isolated World | scroll/lazy-load preheating helpers |

## Communication
- Action Click -> Background -> Content Script (`TOGGLE_PANEL` / `OPEN_PANEL`)
- Content Script -> Background:
  - `DOWNLOAD_IMAGE` (dataUrl + filename)
  - `DOWNLOAD_IMAGE_URL` (imageUrl + filename + watermarkMode)
  - `SUPPRESS_DOWNLOADS` on/off
- Main World -> Content Script:
  - `GBD_IMAGE_CAPTURED` (includes `captureId`)
- Content Script -> Main World:
  - `GBD_CAPTURE_EXPECT` / `GBD_CAPTURE_CANCEL`

## Key Implementation Notes
- Gemini display URLs (`/gg/`) and download URLs (`/gg-dl/`, `/rd-gg-dl/`) use different signed tokens.
- Gemini original capture is tied to native click flow; extension piggybacks and intercepts final image response.
- Gemini capture is matched by `captureId` to prevent late-response mismatch after timeout.
- NotebookLM infographic flow uses artifact button detection + viewer image URL extraction (`/notebooklm/` or `/rd-notebooklm/`).
- NotebookLM watermark cleanup uses local-difference masking with full-region column-fill fallback.
- Background watermark removal mode is controlled per message (`watermarkMode`).
- During Gemini batch, `chrome.downloads.onCreated` cancels duplicate `blob:` downloads not initiated by extension.

## Development Workflow
1. Install: `pnpm install`
2. Dev: `pnpm dev`
3. Build: `pnpm build`
4. Load `dist/` in `chrome://extensions`

## Project Rules
- Use `pnpm`
- Keep Manifest V3 compatible
- Keep panel dark-themed and visually aligned with Gemini / NotebookLM

## Operational Docs (docs/)
1. All operational docs use front-matter metadata (`summary`, `read_when`).
2. Before creating a new doc, run `pnpm docs:list` to review the existing index.
3. Before starting work, check `read_when` hints and read relevant docs as needed.
4. For Gemini interception details, see `docs/download-interception-architecture.md`.
