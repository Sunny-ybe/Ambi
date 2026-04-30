# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome MV3 extension that is the client half of **Ambi** — a local-first memory retrieval system. It silently tracks how long the user dwells on pages, ingests that data into a local FastAPI backend, and provides a keyboard-triggered search panel to query their browsing history by semantic similarity.

The backend lives at `/Users/sashikantkumar/Desktop/ambi` and must be running at `http://127.0.0.1:8000` for any network calls to work.

---

## Coding behavior

> These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### Think before coding
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If something is unclear, stop. Name what's confusing. Ask.

### Simplicity first
- No features beyond what was asked.
- No abstractions for single-use code.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

### Surgical changes
- Don't "improve" adjacent code, comments, or formatting.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that YOUR changes made unused, but leave pre-existing dead code alone.

### Goal-driven execution
For multi-step tasks, state a brief plan before starting:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```
Transform vague tasks into verifiable goals before implementing.

---

## Architecture

Three files, two distinct responsibilities:

### `background.js` — service worker (dwell tracking + API bridge)

**Dwell tracking:** Measures time-on-page and POSTs to `/ingest` when the user leaves a page, but only if they stayed ≥ 10 seconds (`MINIMUM_DWELL_TIME_MS`). A "session" is `{ activeTabId, url, title, startTime }` stored in `chrome.storage.local`.

Sessions are finalized (and optionally ingested) when:
- The user switches tabs (`tabs.onActivated`)
- The user switches windows (`windows.onFocusChanged`)
- A tab is closed (`tabs.onRemoved`)
- The content script reports a URL change via `PAGE_METADATA_MESSAGE`

**State deduplication:** `reconcileActiveSession()` computes a signature (`window:N:tab:N:url:X`) and skips processing if the same signature was seen within 200ms (`STATE_DEBOUNCE_MS`) — prevents redundant work from rapid event bursts.

**Operation queue:** All state-mutating operations run through a single `operationQueue` (a chained Promise) to prevent race conditions from concurrent Chrome events.

**Storage keys** (all in `chrome.storage.local`):
- `dwellActiveSession` — the current in-progress session
- `dwellFocusedWindowId` — cached focused window ID
- `dwellLastProcessedState` — last signature + timestamp for deduplication
- `dwellPageDataByTab` — map of `tabId → { url, title, text }` cached from content script

**Message handling:**
- `PAGE_METADATA` → enqueued via `operationQueue`; updates cached page data, detects SPA navigations
- `SEARCH_QUERY` → proxies to `POST /search`, returns `{ ok, payload }` synchronously via `sendResponse` (returns `true` to keep channel open)
- `OPEN_SEARCH_RESULT` → opens URL in a new tab

### `content.js` — injected into every page

**Page capture:** Extracts page text using Mozilla Readability (falls back to `document.body.innerText`), normalizes whitespace, truncates to 50,000 chars, and sends as `PAGE_METADATA_MESSAGE` to the background. Debounced at 300ms. Triggered on: `load`, `popstate`, `hashchange`, `history.pushState`, `history.replaceState`, `<title>` MutationObserver.

**Search panel UI:** A Shadow DOM panel (`#ambi-search-root`) injected into `document.documentElement`. Shadow DOM isolates styles from the host page. The panel:
- Opens/closes via `TOGGLE_SEARCH_PANEL_MESSAGE` from background (triggered by hotkey)
- Debounces search input at 180ms before sending `SEARCH_QUERY_MESSAGE`
- Renders results with title, snippet, URL, domain, time spent, and related pages per cluster
- Shows a `context_label` header when the backend identifies a dominant topic cluster

**Focus fix for SPAs (e.g. Claude.ai):** All keyboard events (`keydown`, `keyup`, `keypress`) inside the input call `stopPropagation()` to prevent host-page document listeners from stealing focus. `mousedown` on the panel also stops propagation.

### `Readability.js`

Mozilla's Readability library, vendored directly. Used by `content.js` to extract clean article text. Do not modify.

## Message protocol

| Type | Direction | Payload |
|---|---|---|
| `PAGE_METADATA` | content → background | `{ url, title, text }` |
| `SEARCH_QUERY` | content → background | `{ query }` — returns `{ ok, payload }` |
| `OPEN_SEARCH_RESULT` | content → background | `{ url }` |
| `TOGGLE_SEARCH_PANEL` | background → content | (no payload) |

## Backend API (must be running locally)

- `POST /ingest` — `{ url, title, text, timestamp, time_spent }`
- `POST /search` — `{ query }` — returns `{ results, context_label }`

---

## How to load / reload

No build step. Load unpacked in Chrome (`chrome://extensions` → Developer mode → Load unpacked → select this folder).

After any code change: click the ↺ reload button on the extension card, then **refresh any open tabs** — existing content scripts are invalidated on reload and will throw "Extension context invalidated" until the tab is refreshed.

**Hotkey:** `Cmd+Shift+K` (Mac) / `Ctrl+Shift+K` (Windows) — toggles the search panel on the active tab.

## Known gotchas

- **Tab refresh required after reload** — hotkey and content script will silently fail in tabs that were open before the extension was reloaded. Always refresh tabs after reloading the extension.
- **Backend must be running** — all ingest and search calls fail silently if the FastAPI server is down. Check with `curl http://127.0.0.1:8000/health`. The launchd agent (`~/Library/LaunchAgents/com.ambi.server.plist`) should auto-start it on login.
- **"Extension context invalidated" errors** — not a code bug. Happens when old content scripts in open tabs try to message a reloaded service worker. Fix: refresh the tab.
- **Clusters start empty** — existing page visits ingested before the clustering feature was added have no cluster assignment. They populate naturally as new pages are visited.
