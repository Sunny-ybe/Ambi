# Extension CLAUDE.md

> Full project context (architecture, features, API, scoring, cluster system, data flow) is in `/Users/sashikantkumar/Desktop/ambi/CLAUDE.md`. Read that first.

---

## This folder

Chrome MV3 extension — **no build step**. Load unpacked directly in Chrome.

```
extension/
├── manifest.json    ← Permissions, hotkey (Cmd+Shift+K), content_scripts config
├── background.js    ← Service worker: dwell tracking, API bridge, message router
├── content.js       ← Injected into every page: text capture + search panel UI
└── Readability.js   ← Mozilla Readability vendored — DO NOT MODIFY
```

## After any code change

1. `chrome://extensions` → click ↺ on the Ambi card
2. Refresh any open tabs (or just press the hotkey — the injection fallback handles it)

## Coding rules

- No features beyond what was asked
- No abstractions for single-use code
- Match existing style exactly
- Don't touch adjacent code that isn't part of the task

## Key internals to know before touching anything

**`safeSendMessage(message)`** — use this for fire-and-forget sends from content.js. It checks `chrome.runtime?.id` first and swallows "Extension context invalidated" errors silently. Do NOT use bare `chrome.runtime.sendMessage` for one-way messages.

**`isExtensionContextValid()`** — call this before any `chrome.runtime` usage in async paths (e.g. inside setTimeout, event handlers that fire after a delay).

**Shadow DOM panel** — all search UI lives inside `#ambi-search-root`'s shadow root. CSS added to the host page won't affect it. When adding styles, add them to the `style.textContent` block inside `ensureSearchPanel()`.

**`operationQueue`** in background.js — all state-mutating operations (session start/end, page data upsert) must be enqueued via `enqueueOperation()`. Never call them bare — they'll race.

**`return true`** in `onMessage.addListener` — required for any handler that calls `sendResponse` asynchronously. Forgetting this causes the response to be silently dropped.

**Twitter capture** — `setupTwitterBookmarkCapture()` activates only on `x.com/i/bookmarks`. The IntersectionObserver fires per-article at 0.5 threshold. MutationObserver catches new DOM nodes from infinite scroll. Both are torn down via `teardownTwitterBookmarkCapture()` when the user navigates away.

## Message constants (both files must stay in sync)

```js
PAGE_METADATA_MESSAGE      = "PAGE_METADATA"
SEARCH_QUERY_MESSAGE       = "SEARCH_QUERY"
OPEN_SEARCH_RESULT_MESSAGE = "OPEN_SEARCH_RESULT"
TOGGLE_SEARCH_PANEL_MESSAGE = "TOGGLE_SEARCH_PANEL"
INGEST_ITEM_MESSAGE        = "INGEST_ITEM"
DELETE_ITEM_MESSAGE        = "DELETE_ITEM"
```

Any new message type must be added to both `content.js` and `background.js`.
