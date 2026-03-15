# AGENTS.md

## Cursor Cloud specific instructions

### Overview

This is a **Chrome Extension** (Manifest V3) called "Advanced Time Tracker & Focus Guard." It is a fully client-side digital well-being tool — there is no backend, no database, no build step, and no package manager.

### Tech Stack

- Vanilla JavaScript (ES modules for background/utils, plain scripts for popup/content)
- Plain HTML/CSS (no framework, no preprocessor)
- Chrome Extension APIs (`chrome.storage.local`, `chrome.alarms`, `chrome.scripting`, `chrome.i18n`)
- i18n via `_locales/` (en, ja, zh)

### No Dependencies / No Build

There is no `package.json`, no `node_modules`, no bundler, and no build step. The raw source files are loaded directly by Chrome. The update script is effectively a no-op.

### How to Run

1. Launch Chrome/Chromium (headless won't work for extension testing — use `--no-sandbox` flags as needed in the VM).
2. Navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in top-right).
4. Click **Load unpacked** and select `/workspace`.
5. The extension is now installed.

### How to Test

- **Popup**: Click the extension icon in Chrome's toolbar.
- **Options/Dashboard**: Right-click the extension icon → "Options", or navigate to `chrome-extension://<id>/options.html`.
- **Content script**: Visit a tracked domain (e.g., `youtube.com`, `reddit.com`) to see time tracking and overlays in action.
- **No automated tests exist** in this repository. All testing is manual via Chrome.

### Lint / Static Analysis

No linter is configured. There is no ESLint, Prettier, or similar tooling.

### Key Architecture Notes

- `background.js` is a Service Worker (module type) — it handles alarms, message routing, and tab coordination.
- `content.js` is injected into tracked pages via dynamic content script registration (not declared statically in manifest).
- `utils/storage.js` uses a batched write system with an in-memory cache to reduce `chrome.storage.local` writes.
- `utils/sessionManager.js` enforces session limits, rest periods, forbidden time periods, and daily caps.
- The popup (`popup.html`/`popup.js`) shows quick status; the options page (`options.html`/`options.js`) is the full dashboard.
