# Starter Skill: Advanced Time Tracker Chrome Extension

## Quick Context

This is a **Chrome Extension (Manifest V3)** built with vanilla JavaScript. There is no build step, no bundler, no package manager, and no test framework. Source files are loaded directly by Chrome. All data lives in `chrome.storage.local`—there is no backend, no database, and no authentication.

---

## Project Layout

```
manifest.json          – Extension manifest (entry points, permissions)
background.js          – Service worker: alarms, message routing, tab coordination
content.js             – Injected into tracked sites: detectors, overlays, time reporting
popup.html / popup.js  – Extension toolbar popup (quick status)
options.html / options.js / options.css – Dashboard & settings page
overlay.css            – Blocking overlay styles injected by content script
utils/
  storage.js           – chrome.storage CRUD, batched writes, stats, domain limits
  sessionManager.js    – Session lifecycle, rest periods, access-control checks
_locales/{en,ja,zh}/messages.json – i18n strings
icons/                 – Extension icons (16/48/128 px)
```

---

## How to Load and Run

There is no install or build command. The extension runs from source.

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** and select the repo root (`/workspace`).
4. The extension icon appears in the toolbar.

After editing any file, click the **reload** button on the extension card at `chrome://extensions/` to pick up changes. Content scripts require a page refresh on target sites.

---

## Architecture Overview

### Message Flow

Content script → `chrome.runtime.sendMessage` → Background service worker → `chrome.storage.local`

Key message types (defined in `background.js` `handleMessage`):

| Message | Purpose |
|---------|---------|
| `GET_CATEGORY_FOR_DOMAIN` | Look up which category a domain belongs to |
| `CAN_ACCESS` | Check if a category is currently accessible |
| `START_SESSION` / `END_SESSION` | Session lifecycle |
| `ADD_TIME` | Report effective time (capped at limits) |
| `REGISTER_TAB` / `UNREGISTER_TAB` | Tab coordination to prevent duplicate counting |
| `REPORT_ACTIVITY` | Activity heartbeat for active-tab arbitration |
| `GET_TODAY_STATS` / `GET_WEEK_STATS` / `GET_MONTH_STATS` | Statistics queries |
| `SET_DOMAIN_LIMIT` / `CHECK_DOMAIN_LIMIT` | Per-domain limits |

### Detection Modes (content.js)

| Type | Class | Tracks |
|------|-------|--------|
| `video` | `VideoDetector` | `<video>` element `timeupdate` events; paused = no time |
| `reading` | `ReadingDetector` | Scroll/mouse/key activity; idle beyond threshold = no time |
| `social` | `SocialDetector` | Same as reading (subclass, ready for divergence) |

### Storage (utils/storage.js)

- Uses batched writes: time accumulates in memory and flushes every 10 s (or immediately near limits).
- `chrome.alarms` in background.js act as backup flush when the service worker wakes.
- Default categories: `video`, `reading`, `social` (see `DEFAULT_CATEGORIES`).
- Default settings: `globalEnabled`, `showNotifications`, `showBadge`, `strictMode`, `weekStartsOnMonday`.
- Data retention: 31 days (`DATA_RETENTION_DAYS`).

### Session Manager (utils/sessionManager.js)

Access checks run in priority order:
1. Forbidden time period
2. Active rest period
3. Daily limit exhausted
4. Session count exhausted

`addEffectiveTime` caps seconds at both daily-limit headroom and session-duration headroom so totals never overshoot.

---

## Configuration (No Feature Flags)

There are no environment variables, feature flags, or `.env` files. All behavior is controlled through:

- **Category config** stored in `chrome.storage.local` under key `categories`. Editable via the options page or by directly writing to storage.
- **Settings** under key `settings` (see `DEFAULT_SETTINGS` in `storage.js`).
- **Domain limits** under key `domainLimits`.

To mock or override settings during testing, write directly to `chrome.storage.local` from the DevTools console on the extension's background page:

```js
// Example: lower the video daily limit to 60 seconds for quick testing
chrome.storage.local.get('categories', ({categories}) => {
  categories.video.dailyLimit = 60;
  categories.video.sessionDuration = 30;
  categories.video.restDuration = 10;
  chrome.storage.local.set({categories});
});
```

---

## Debugging

| Target | How to open DevTools |
|--------|---------------------|
| Background service worker | `chrome://extensions/` → click "Service worker" link on the extension card |
| Popup | Right-click extension icon → "Inspect popup" |
| Options page | Open `chrome-extension://<id>/options.html` → standard DevTools (F12) |
| Content script | Open DevTools on a tracked site (e.g., youtube.com) → Console shows `[TimeTracker]` logs |

Console log prefixes to search for: `[TimeTracker]`, `[TabCoord]`, `[ContentScript]`, `[StorageCache]`, `[DailyReset]`, `[DateChange]`.

---

## Testing Workflows by Area

### 1. Content Script & Time Detection

**Goal:** Verify that effective time is tracked only during active consumption.

1. Load the extension and go to `youtube.com`.
2. Open DevTools on YouTube; filter console for `[TimeTracker]`.
3. Play a video — confirm `ADD_TIME` messages appear every ~5 seconds.
4. Pause the video — confirm time reporting stops.
5. Check the popup shows increasing time for the Video category.

**For reading/social:** Go to `reddit.com`, scroll around (time counts), then stop interacting for >30 s (idle timeout). Confirm time stops accumulating.

### 2. Session & Rest Enforcement

**Goal:** Verify session limits trigger rest overlay.

1. Override session duration to a small value for quick testing:
   ```js
   chrome.storage.local.get('categories', ({categories}) => {
     categories.video.sessionDuration = 15; // 15 seconds
     categories.video.restDuration = 10;    // 10 seconds rest
     chrome.storage.local.set({categories});
   });
   ```
2. Reload extension, go to YouTube, play a video.
3. After ~15 s of playback, confirm the blocking overlay appears with a rest countdown.
4. Wait for countdown to finish; confirm overlay disappears and tracking resumes.

### 3. Daily Limits

**Goal:** Verify daily limit blocks access.

1. Set a tiny daily limit:
   ```js
   chrome.storage.local.get('categories', ({categories}) => {
     categories.video.dailyLimit = 20; // 20 seconds
     chrome.storage.local.set({categories});
   });
   ```
2. Watch a video; after ~20 s, confirm "Daily Limit Reached" overlay.

### 4. Forbidden Periods

**Goal:** Verify time-of-day blocking.

1. Add a forbidden period covering the current time:
   ```js
   chrome.storage.local.get('categories', ({categories}) => {
     categories.video.forbiddenPeriods = [{start: '00:00', end: '23:59'}];
     chrome.storage.local.set({categories});
   });
   ```
2. Reload extension, go to YouTube → immediate block overlay.
3. Remove the period and reload → access restored.

### 5. Domain-Specific Limits

**Goal:** Verify per-domain limits override category limits.

1. Set a domain limit via the options page or DevTools:
   ```js
   chrome.runtime.sendMessage({type: 'SET_DOMAIN_LIMIT', domain: 'youtube.com', dailyLimit: 15});
   ```
2. Watch YouTube for 15 s → "Website Limit Reached" overlay.

### 6. Options Page (Dashboard & Settings)

**Goal:** Verify CRUD, stats display, data export.

1. Open the options page (`chrome-extension://<id>/options.html`).
2. **Statistics tab:** Confirm Today / This Week / This Month show correct data after usage.
3. **Settings tab:** Add a new category, edit an existing one, delete one. Confirm changes persist after reload.
4. **Domain limits:** Add and remove a domain limit. Confirm it takes effect on the target site.
5. **Data management:** Export data (JSON download), Reset Today, Clear All Data.

### 7. Tab Coordination

**Goal:** Verify only one tab per category counts time.

1. Open two YouTube tabs with videos playing.
2. Check background service worker logs for `[TabCoord]` — only one tab should be `isActive: true`.
3. Switch focus between tabs; the foreground tab should take over as active.

### 8. i18n / Localization

**Goal:** Verify locale strings render correctly.

1. Check that popup and options page show English text (no raw `__MSG_*__` tokens).
2. To test another locale, change Chrome's language in `chrome://settings/languages` or launch Chrome with `--lang=ja`.

### 9. Midnight Reset

**Goal:** Verify daily reset clears sessions and usage.

1. In the background DevTools console, manually trigger:
   ```js
   // (This function is in the background module scope; call via the alarm handler)
   chrome.alarms.create('midnightReset', {when: Date.now() + 1000});
   ```
2. After 1 s, confirm active sessions are cleared and content scripts re-initialize (watch for `[DailyReset]` logs).

---

## Linting and Formatting

No linter or formatter is configured. If you add ESLint, a reasonable starting point:

```bash
npm init -y
npm install --save-dev eslint
npx eslint --init  # choose browser environment, ES modules
```

---

## Automated Tests

No test framework exists yet. If you need to add tests, the pure utility functions in `utils/storage.js` (e.g., `matchDomain`, `formatTime`, `parseTimeToMinutes`, `isInForbiddenPeriod`) are the best candidates for unit tests since they don't depend on Chrome APIs.

A minimal setup would use a Chrome API mock (like `jest-chrome` or `sinon-chrome`) to stub `chrome.storage.local`.

---

## Updating This Skill

When you discover new testing tricks, runbook knowledge, or codebase patterns:

1. **Add concrete steps.** Every entry should include exact console commands, DevTools paths, or code snippets—not vague descriptions.
2. **Organize by area.** New workflows go under the matching section above (or create a new section if the area is new).
3. **Record failure modes.** If a common pitfall trips you up (e.g., forgetting to reload the extension after editing `background.js`), add a callout under the relevant section.
4. **Keep it minimal.** Remove information that becomes stale or redundant. A short, accurate skill beats a long, outdated one.
5. **Date your additions.** Add a `<!-- Updated: YYYY-MM-DD -->` comment at the bottom when making nontrivial changes so future agents can gauge freshness.

<!-- Updated: 2026-03-16 -->
