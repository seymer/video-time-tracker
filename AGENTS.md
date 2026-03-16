# AGENTS.md

## Project

Advanced Time Tracker — a Chrome Extension (Manifest V3) built with vanilla JavaScript. No build step, no bundler, no package manager, no backend.

## Skills

- `.cursor/skills/starter.md`: How to load, run, debug, and test this Chrome extension. Use when making any code change or investigating any issue.

## Key Facts

- Source files are used directly by Chrome; there is no compilation or bundling.
- After editing files, reload the extension at `chrome://extensions/` and refresh target pages.
- All state lives in `chrome.storage.local`. There are no environment variables, feature flags, or remote services.
- No automated test suite exists. Manual testing is done by loading the extension in Chrome.
- No linter or formatter is configured.

## Cursor Cloud Specific Instructions

This is a Chrome extension that requires a browser to test interactively. Cloud agents should:

1. Use the `computerUse` subagent to load the extension in Chrome and perform GUI-based testing.
2. Override category settings via `chrome.storage.local` to create short limits for quick manual testing (see starter skill for exact snippets).
3. Check the background service worker console for `[TimeTracker]`, `[TabCoord]`, `[StorageCache]`, and `[DailyReset]` log prefixes to verify behavior.
