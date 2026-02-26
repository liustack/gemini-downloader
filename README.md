# banana-downloader

English documentation. For Chinese users, see [README.zh-CN.md](README.zh-CN.md).

A Chrome extension for Google Gemini that opens an in-page panel when you click the extension icon, then lets you batch-download full-resolution generated images from the current conversation — with automatic watermark removal.

## Notice

This project is published for personal learning purposes only and must not be used for any commercial purposes.

## Features

- In-page Shadow DOM panel (no popup page)
- Automatic Gemini image detection with select all / unselect all
- Full-resolution download via simulated native button click + fetch interception
- Automatic Gemini watermark removal (reverse alpha blending in background)
- Batch timestamp filenames to avoid collisions (`prefix_YYYYMMDD_HHmmss_N.png`)
- Real-time download progress and result feedback

## How It Works

The extension uses a 3-layer architecture:

| Layer | File | Runtime | Role |
|-------|------|---------|------|
| Interceptor | `public/download-interceptor.js` | Main World | Patches `window.fetch` to capture original image blobs from Gemini's download redirect chain |
| Content Script | `src/content/index.ts` | Isolated World | UI panel + orchestrates download flow (find button → click → wait for blob → send to background) |
| Background | `src/background/index.ts` | Service Worker | Watermark removal + file save + native download suppression |

**Download flow:**

1. Click the extension action icon → background sends `TOGGLE_PANEL` to the Gemini tab
2. Content script scans page images and renders the in-page panel
3. User selects images and clicks download
4. Content script injects the Main World interceptor and enables download suppression
5. For each image serially: click native download button → interceptor captures the blob via patched `fetch` → blob is forwarded to content script via `postMessage`
6. Content script sends `DOWNLOAD_IMAGE` (with dataUrl + filename) to background
7. Background removes the Gemini watermark and saves the file via `chrome.downloads`

## Tech Stack

- Chrome Extension Manifest V3
- TypeScript 5.9
- Vite 6.4 + `@crxjs/vite-plugin` 2.3
- pnpm

## Project Structure

```text
src/
  background/index.ts          # Action click handling + watermark removal + download suppression
  content/index.ts             # Image scanning + in-page panel UI + download orchestration
  core/
    watermarkEngine.ts         # Watermark removal via reverse alpha blending
    alphaMap.ts                # Pre-computed alpha channel map
    blendModes.ts              # Blend mode utilities
  types.ts                     # Shared message/data types
  assets/                      # Watermark reference images
public/
  download-interceptor.js      # Main World fetch patch (injected at runtime)
  rules.json                   # Declarative net request CORS rules
  icons/                       # Extension icons
docs/                          # Operational & architecture docs
manifest.json
AGENTS.md                      # AI agent project context
```

## Local Development

```bash
pnpm install
pnpm dev
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click "Load unpacked"
4. Select the `dist/` directory

## Build

```bash
pnpm build
```

Build output is generated in `dist/`.

## Usage

1. Open `https://gemini.google.com/`
2. Open a conversation with generated images
3. Click the extension icon
4. Use the panel in the top-right corner to choose images and download

## Troubleshooting

### Panel does not appear after clicking the icon

- Refresh the Gemini page and try again (content script needs injection on the latest page state)
- Make sure you loaded the latest `dist/`

### No images are detected

- Confirm the conversation already has rendered generated images
- Scroll to trigger lazy loading, then try again

### Downloads fail

- Check Gemini login status
- Check extension Errors / Service Worker logs in `chrome://extensions`

## Permissions

- `activeTab`: interact with the active tab via extension action flow
- `downloads`: call Chrome downloads API
- `declarativeNetRequestWithHostAccess`: modify response headers (CORS) for `lh3.googleusercontent.com` image requests
- `host_permissions`:
  - `https://gemini.google.com/*` — inject content script and interact with Gemini page
  - `https://lh3.googleusercontent.com/*`, `https://lh3.google.com/*` — access image resources for watermark processing

## License

MIT. See [LICENSE](LICENSE).
