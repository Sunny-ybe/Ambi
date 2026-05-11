# Ambi — Project Context for Claude

Ambi is a **local-first personal memory system**. A Chrome extension silently tracks pages the user dwells on, ingests them into a local FastAPI backend, and lets the user search their browsing history semantically via a keyboard-triggered overlay panel.

Everything runs on the user's machine. No cloud. No accounts.

---

## Sub-agent routing

Four agents live in `.claude/agents/`. Use them as follows.

### Default feature chain

When implementing a new feature or non-trivial bug fix, run this pipeline:

```
1. code-writer          (sequential — must finish first)
        ↓
2. security-auditor  +  test-writer    (parallel — no dependency between them)
        ↓
3. code-reviewer        (sequential — synthesizes output of steps 1 & 2)
```

### When to run in parallel

Spawn agents in parallel when their tasks touch **different files with no output dependency**:

- `security-auditor` and `test-writer` always run in parallel after `code-writer` — they both only read code-writer's output
- Two independent `code-writer` tasks that touch disjoint files (e.g. a server change and an unrelated manifest change) can run in parallel
- `code-reviewer` must always be last — it synthesizes findings from all prior agents

### When to run sequentially

Run agents sequentially when Task B needs Task A's output:

- `code-writer` → `security-auditor` (auditor reads the finished code)
- `code-writer` → `test-writer` (test-writer reads the finished code)
- `{security-auditor + test-writer}` → `code-reviewer` (reviewer synthesizes both)

### Quick-task shortcuts

| Task | Agents |
|---|---|
| "Is this code secure?" | `security-auditor` only |
| "Review this PR" | `security-auditor` + `code-reviewer` in parallel |
| "Write tests for X" | `test-writer` only |
| "Fix this bug" | `code-writer` → `code-reviewer` (skip security + tests for trivial fixes) |
| "Add feature X" | Full chain: code-writer → [security-auditor + test-writer] → code-reviewer |

### Agent file ownership

| Agent | May write | Read-only |
|---|---|---|
| `code-writer` | `extension/background.js`, `extension/content.js`, `extension/manifest.json`, `extension/panel.css`, `server/main.py`, `server/db.py`, `server/embedding.py` | everything else |
| `security-auditor` | nothing | all source files |
| `test-writer` | `tests/**` | all source files |
| `code-reviewer` | nothing | all source files + agent outputs |

---

## How to start everything

```bash
# 1. Start the backend (from the ambi root)
cd /Users/sashikantkumar/Desktop/ambi
source ambivenv/bin/activate
uvicorn server.main:app --reload

# 2. Verify it's up
curl http://127.0.0.1:8000/health   # → {"status":"ok"}

# 3. Load the extension in Chrome
# chrome://extensions → Developer mode ON → Load unpacked → select extension/

# 4. After any code change to the extension:
# Click ↺ on the extension card in chrome://extensions
# Then refresh any tabs that were already open
```

Ollama must be running for embeddings (`nomic-embed-text` model used in some configs — check `server/embedding.py`; current version uses `sentence-transformers/all-MiniLM-L6-v2` via Python directly, so Ollama is not required).

---

## Repository layout

```
ambi/
├── extension/              ← Chrome MV3 extension (no build step)
│   ├── manifest.json       ← Permissions, hotkey definition, content script config
│   ├── background.js       ← Service worker: dwell tracking, API bridge
│   ├── content.js          ← Injected into every page: text capture, search panel UI
│   └── Readability.js      ← Mozilla Readability vendored lib — DO NOT MODIFY
├── server/                 ← FastAPI backend Python package
│   ├── main.py             ← All HTTP endpoints + scoring logic
│   ├── db.py               ← SQLite helpers + cluster assignment logic
│   ├── embedding.py        ← ChromaDB + sentence-transformers vector store
│   ├── ambi_v0.db          ← SQLite database (gitignored)
│   └── chroma_db/          ← ChromaDB vector store (gitignored)
└── ambivenv/               ← Python virtualenv (gitignored)
```

---

## Complete feature list

### Passive tracking
- Every page the user visits for **≥ 10 seconds** is ingested (url, title, extracted text, time spent)
- Text extracted via Mozilla Readability first; falls back to `document.body.innerText`
- Skips: `chrome://`, `chrome-extension://`, `about:blank`, empty/no-content pages, incognito tabs
- SPA navigation detected by wrapping `history.pushState` / `history.replaceState` + `popstate` / `hashchange` events
- Dwell time is per-URL: switching tabs or closing a tab finalizes the session and fires the ingest

### Twitter/X bookmark scroll capture
- Activates automatically when user is on `x.com/i/bookmarks` or `twitter.com/i/bookmarks`
- Uses **IntersectionObserver** (threshold: 0.5) — fires the moment a tweet article is 50% visible
- Uses **MutationObserver** on `document.body` to catch new tweets appended by infinite scroll
- Extracts per-tweet: status URL (`a[href*="/status/"]`), text (`[data-testid="tweetText"]`), author handle from URL, datetime from `<time datetime>` attribute
- Assigns **30-second synthetic dwell time** (bypasses the 10s minimum gate)
- Deduplicates by URL within a session via `twitterIngestedUrls` Set
- Tears down observers when user navigates away from bookmarks

### Search panel
- Triggered by **`Cmd+Shift+K`** (Mac) / `Ctrl+Shift+K` (Windows)
- Rendered in a **Shadow DOM** (`#ambi-search-root`) — fully isolated from host page styles
- Searches debounced at 180ms; results come from `POST /search`
- Shows: title, snippet (keyword-highlighted extract), domain, time spent, related pages
- **Context header**: clickable label showing the dominant topic cluster ("You've been exploring: React Hooks"). Click to filter results to that cluster; click again to clear filter
- **Delete button**: × appears on hover over each result card; shows "Permanently delete this?" tooltip; fades card out on success; calls `DELETE /delete-by-url` via background
- Closes on Escape or click outside the panel

### Hotkey injection fallback
- If the tab was open before the extension loaded/reloaded, `content.js` won't be there
- When the hotkey fires, background catches "Receiving end does not exist" and injects `Readability.js` + `content.js` programmatically via `chrome.scripting.executeScript`, then retries
- Works silently — user never needs to refresh

### Incognito blocking
- `handlePageMetadata` checks `sender.tab?.incognito` → returns immediately if true
- `getDesiredActiveTab` checks `activeTab.incognito` → returns null if true
- Nothing from incognito tabs reaches the backend

### Delete from memory
- Delete button in the search panel (see above)
- Also available via API directly:
  - `DELETE /delete-by-url` with body `{"url": "..."}` — finds by URL
  - `DELETE /delete/{id}` — deletes by SQLite row id
- Both remove from SQLite **and** ChromaDB

---

## Message protocol (content.js ↔ background.js)

| Constant | Direction | What it does |
|---|---|---|
| `PAGE_METADATA` | content → background | Sends extracted page data; enqueued via operationQueue |
| `SEARCH_QUERY` | content → background | Proxies to `POST /search`; returns `{ok, payload}` via sendResponse |
| `OPEN_SEARCH_RESULT` | content → background | Opens URL in new tab |
| `TOGGLE_SEARCH_PANEL` | background → content | Tells content script to open/close the panel |
| `INGEST_ITEM` | content → background | Direct ingest (used by Twitter capture, bypasses dwell gate) |
| `DELETE_ITEM` | content → background | Calls `DELETE /delete-by-url`; returns `{ok, status}` |

Handlers that need async responses must `return true` in `onMessage.addListener` to keep the channel open.

---

## Backend API endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| GET | `/health` | — | Returns `{"status":"ok"}` |
| GET | `/clusters` | — | All clusters with representative items (debug) |
| POST | `/ingest` | `{url, title, text, timestamp, time_spent}` | Ingest a page visit |
| POST | `/search` | `{query}` | Returns top 5 results with scores, snippets, related |
| DELETE | `/delete-by-url` | `{url}` | Delete by URL from SQLite + ChromaDB |
| DELETE | `/delete/{id}` | — | Delete by SQLite row id |

Swagger UI: `http://127.0.0.1:8000/docs`

---

## Search scoring (main.py)

Each candidate result gets a composite score:

```
score = semantic * 0.60
      + keyword  * 0.25
      + recency_boost        # max 0.12, decays over 24h
      + time_boost           # max 0.10, log scale on total_time_spent
      + cluster_boost        # +0.10 flat if in dominant cluster
      + confidence * 0.13   # scales cluster_confidence [0,1]
```

- **Semantic**: cosine similarity from ChromaDB vector search (top 20 candidates)
- **Keyword**: SQLite LIKE search scoring title (3pts) > url (2pts) > text (1pt), normalized
- **Dominant cluster**: determined by majority vote among top-5 semantic hits
- Top 5 results returned; each gets `related` items from the same cluster

---

## Cluster system (db.py)

Clusters group semantically related pages. They are maintained automatically:

- **Assignment**: on every ingest, the page embedding is compared to all cluster centroids via cosine similarity
  - Similarity ≥ 0.65 → join that cluster
  - Below threshold and < 20 clusters exist → create new cluster
  - Below threshold and at cap → join closest anyway
- **Centroid update**: incremental weighted average; every 10 additions, recomputed from representative embeddings
- **Labels**: rebuilt every 5 ingests to that cluster from representative titles using bigram/unigram frequency
- **Merging**: checked every 20 total ingests; clusters with centroid similarity ≥ 0.88 and size ratio > 0.3 are merged
- **Confidence**: stored per page visit (`cluster_confidence`); low-confidence members re-evaluated after merges

---

## Data flow (end to end)

```
User visits a page
  → content.js: Readability extracts text, debounces 300ms
  → sends PAGE_METADATA to background.js
  → background.js: caches page data, starts/updates dwell session

User leaves page (tab switch / close / navigation)
  → background.js: finalizes session if dwell ≥ 10s
  → POST /ingest
  → main.py: upserts page_visit in SQLite, embeds text, upserts in ChromaDB
  → assigns to cluster, maybe refreshes label, maybe merges clusters

User presses Cmd+Shift+K
  → background.js: queries active tab, sends TOGGLE_SEARCH_PANEL
    (if content script missing → injects scripts first, then retries)
  → content.js: opens Shadow DOM panel

User types query
  → content.js debounces 180ms → sends SEARCH_QUERY to background
  → background proxies to POST /search
  → main.py: vector search + keyword search → scores → top 5 + related
  → content.js renders results

User clicks × on a result
  → content.js sends DELETE_ITEM to background
  → background calls DELETE /delete-by-url
  → main.py deletes from SQLite and ChromaDB
  → content.js fades the card out
```

---

## Known gotchas

- **Always restart uvicorn after changing server code** — `--reload` handles file changes automatically, but if the process was killed and restarted manually, make sure the virtualenv is active
- **Tab refresh required after extension reload** — hotkey and content script fail silently in stale tabs. The injection fallback handles this now, but a full refresh is always cleaner
- **Delete returns 404 for URLs not in DB** — content.js treats 404 as success (item is already gone) and still fades the card
- **Twitter capture only works on /i/bookmarks** — it does not run on the main feed or other Twitter pages
- **Clusters start empty** — pages ingested before clustering was added have no cluster. They get assigned on next visit
- **Incognito**: extension should have "Allow in Incognito" turned OFF in chrome://extensions for maximum privacy. Code-level guard exists as a second layer
- **`chrome.runtime.id` check**: `isExtensionContextValid()` in content.js guards all `chrome.runtime` calls to prevent "Extension context invalidated" crashes when extension is reloaded while tabs are open

---

## GitHub

`https://github.com/Sunny-ybe/Ambi.git` — main branch
