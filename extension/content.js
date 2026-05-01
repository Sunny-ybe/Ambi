const PAGE_METADATA_MESSAGE = "PAGE_METADATA"
const SEARCH_QUERY_MESSAGE = "SEARCH_QUERY"
const OPEN_SEARCH_RESULT_MESSAGE = "OPEN_SEARCH_RESULT"
const TOGGLE_SEARCH_PANEL_MESSAGE = "TOGGLE_SEARCH_PANEL"
const INGEST_ITEM_MESSAGE = "INGEST_ITEM"
const PAGE_SNAPSHOT_DEBOUNCE_MS = 300
const MAX_TEXT_LENGTH = 50_000

let lastPageMetadata = {
  title: "",
  url: "",
  text: ""
}

let searchDebounceTimer = null
let pageSnapshotTimer = null
let ambiPanelElements = null
let lastSearchPayload = null

function normalizeText(text = "") {
  return text
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

function isExtensionContextValid() {
  try {
    return !!chrome.runtime?.id
  } catch {
    return false
  }
}

function safeSendMessage(message) {
  if (!isExtensionContextValid()) return
  try {
    chrome.runtime.sendMessage(message)
  } catch (e) {
    if (!e?.message?.includes("Extension context invalidated")) {
      console.error("sendMessage failed:", e)
    }
  }
}

function extractMainText() {
  try {
    if (typeof Readability !== "function") {
      throw new Error("Readability is not available.")
    }

    const documentClone = document.cloneNode(true)
    // Walk the tree and remove any node whose nodeType isn't element/text/comment
    // to prevent Readability crashing on null-tagName nodes (SVG, custom, etc.)
    documentClone.querySelectorAll("script, style, noscript, template, svg, math").forEach(el => el.remove())
    const article = new Readability(documentClone).parse()
    const extractedText = normalizeText(article?.textContent || "")

    if (extractedText) {
      return {
        title: article?.title || document.title,
        text: extractedText.slice(0, MAX_TEXT_LENGTH)
      }
    }
  } catch {
    // Silently fall through to body.innerText fallback
  }

  return {
    title: document.title,
    text: normalizeText(document.body?.innerText || "").slice(0, MAX_TEXT_LENGTH)
  }
}

function sendPageMetadata() {
  const extractedContent = extractMainText()
  const nextPageMetadata = {
    title: extractedContent.title,
    url: window.location.href,
    text: extractedContent.text
  }

  if (
    nextPageMetadata.title === lastPageMetadata.title &&
    nextPageMetadata.url === lastPageMetadata.url &&
    nextPageMetadata.text === lastPageMetadata.text
  ) {
    return
  }

  lastPageMetadata = nextPageMetadata

  safeSendMessage({
    type: PAGE_METADATA_MESSAGE,
    payload: nextPageMetadata
  })
}

function schedulePageSnapshot() {
  if (pageSnapshotTimer) {
    clearTimeout(pageSnapshotTimer)
  }

  pageSnapshotTimer = window.setTimeout(() => {
    sendPageMetadata()
  }, PAGE_SNAPSHOT_DEBOUNCE_MS)
}

function wrapHistoryMethod(methodName) {
  const originalMethod = history[methodName]

  history[methodName] = function (...args) {
    const result = originalMethod.apply(this, args)
    queueMicrotask(schedulePageSnapshot)
    return result
  }
}

function escapeHtml(value = "") {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function formatTimeSpent(totalTimeSpent = 0) {
  const totalSeconds = Math.max(0, Math.round(totalTimeSpent / 1000))

  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  }

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`
}

function truncateUrl(url, maxLength = 64) {
  if (!url || url.length <= maxLength) {
    return url
  }

  return `${url.slice(0, maxLength - 3)}...`
}

const LABEL_GENERIC_WORDS = new Set([
  "the", "a", "an", "and", "or", "in", "on", "to", "for", "of", "with",
  "is", "are", "was", "how", "what", "this", "that", "it", "my", "your",
  "data", "system", "model", "page", "web", "site", "info", "main",
  "home", "type", "item", "base", "app", "new", "using", "from", "about"
])

function toTitleCase(word) {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function generateContextLabel(contextLabel, topItems) {
  // Derive a phrase from the top items' titles: most frequent meaningful words
  const titleWords = topItems.slice(0, 3)
    .flatMap(item => (item.title || "").toLowerCase().split(/[\s\-–_\/|,.()\[\]"']+/))
    .filter(w => w.length > 3 && !LABEL_GENERIC_WORDS.has(w))

  if (titleWords.length >= 3) {
    const freq = {}
    for (const w of titleWords) {
      freq[w] = (freq[w] || 0) + 1
    }
    const candidates = Object.entries(freq)
      .sort(([a, fa], [b, fb]) => fb - fa || b.length - a.length)
      .slice(0, 4)
      .map(([w]) => toTitleCase(w))

    if (candidates.length >= 2) {
      return candidates.join(" ")
    }
  }

  // Fallback: prettify the slash-separated backend label
  const parts = (contextLabel || "")
    .split(/\s*[\/\|\-–]\s*/)
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length > 1 && !LABEL_GENERIC_WORDS.has(w))

  if (parts.length >= 1) {
    return parts.slice(0, 5).map(toTitleCase).join(" ")
  }

  return (contextLabel || "").replace(/\b\w/g, c => c.toUpperCase())
}

function ensureSearchPanel() {
  if (ambiPanelElements) {
    return ambiPanelElements
  }

  const root = document.createElement("div")
  root.id = "ambi-search-root"

  const shadowRoot = root.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = `
    :host {
      all: initial;
    }

    .ambi-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      display: none;
      background: rgba(7, 10, 18, 0.22);
      backdrop-filter: blur(8px);
      font-family: "SF Pro Display", "Segoe UI", sans-serif;
    }

    .ambi-backdrop[data-open="true"] {
      display: block;
    }

    .ambi-panel {
      width: min(720px, calc(100vw - 32px));
      margin: 72px auto 0;
      border: 1px solid rgba(20, 35, 64, 0.12);
      border-radius: 24px;
      overflow: hidden;
      background:
        linear-gradient(135deg, rgba(252, 249, 240, 0.98), rgba(245, 247, 255, 0.98));
      box-shadow:
        0 24px 80px rgba(11, 19, 41, 0.18),
        0 4px 18px rgba(11, 19, 41, 0.08);
      color: #11213e;
    }

    .ambi-header {
      padding: 18px 18px 12px;
      border-bottom: 1px solid rgba(20, 35, 64, 0.08);
    }

    .ambi-title {
      margin: 0 0 10px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #6c7a99;
    }

    .ambi-input {
      width: 100%;
      border: 0;
      outline: none;
      background: rgba(255, 255, 255, 0.75);
      border-radius: 16px;
      padding: 16px 18px;
      box-sizing: border-box;
      font-size: 18px;
      color: #11213e;
      box-shadow: inset 0 0 0 1px rgba(17, 33, 62, 0.08);
    }

    .ambi-input::placeholder {
      color: #93a0bb;
    }

    .ambi-results {
      max-height: min(70vh, 560px);
      overflow-y: auto;
      padding: 8px;
    }

    .ambi-empty,
    .ambi-status {
      padding: 22px 18px;
      color: #5d6985;
      font-size: 14px;
    }

    .ambi-result {
      width: 100%;
      text-align: left;
      border: 0;
      background: transparent;
      padding: 14px;
      border-radius: 18px;
      cursor: pointer;
      transition: background 140ms ease, transform 140ms ease;
      color: inherit;
    }

    .ambi-result:hover,
    .ambi-result:focus-visible {
      background: rgba(24, 50, 106, 0.08);
      transform: translateY(-1px);
      outline: none;
    }

    .ambi-result-title {
      display: block;
      margin-bottom: 6px;
      font-size: 16px;
      font-weight: 700;
      line-height: 1.35;
      color: #102348;
    }

    .ambi-result-snippet {
      display: block;
      margin-bottom: 8px;
      font-size: 14px;
      line-height: 1.5;
      color: #41506e;
    }

    .ambi-result-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 12px;
      color: #6b7790;
    }

    .ambi-result-url {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 70%;
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    .ambi-result-meta {
      white-space: nowrap;
      font-weight: 600;
    }

    .ambi-context-header {
      padding: 8px 14px 6px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #7b6faa;
      cursor: pointer;
      border-radius: 10px;
      transition: background 120ms ease, color 120ms ease;
      user-select: none;
    }

    .ambi-context-header:hover {
      background: rgba(123, 111, 170, 0.10);
      color: #5a4f8a;
    }

    .ambi-context-header--active {
      background: rgba(123, 111, 170, 0.14);
      color: #5a4f8a;
    }

    .ambi-context-header--active::after {
      content: " ×";
      font-size: 13px;
      font-weight: 700;
      opacity: 0.6;
    }

    .ambi-related {
      margin: 2px 0 4px 14px;
      border-left: 2px solid rgba(123, 111, 170, 0.22);
      padding-left: 10px;
    }

    .ambi-related-label {
      display: block;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #a0a8be;
      padding: 4px 6px 2px;
      margin-bottom: 2px;
    }

    .ambi-related-item {
      width: 100%;
      text-align: left;
      border: 0;
      background: transparent;
      padding: 5px 8px;
      border-radius: 10px;
      cursor: pointer;
      color: inherit;
      display: block;
      transition: background 120ms ease;
    }

    .ambi-related-item:hover,
    .ambi-related-item:focus-visible {
      background: rgba(24, 50, 106, 0.06);
      outline: none;
    }

    .ambi-related-title {
      display: block;
      font-size: 12px;
      font-weight: 500;
      color: #4a5878;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .ambi-related-url {
      display: block;
      font-size: 10px;
      color: #9aa4bc;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 1px;
    }
  `

  const backdrop = document.createElement("div")
  backdrop.className = "ambi-backdrop"
  backdrop.dataset.open = "false"

  const panel = document.createElement("div")
  panel.className = "ambi-panel"

  const header = document.createElement("div")
  header.className = "ambi-header"

  const title = document.createElement("p")
  title.className = "ambi-title"
  title.textContent = "Ambi Search"

  const input = document.createElement("input")
  input.className = "ambi-input"
  input.type = "text"
  input.placeholder = "Search your memory..."
  input.autocomplete = "off"
  input.spellcheck = false

  const results = document.createElement("div")
  results.className = "ambi-results"
  results.innerHTML = '<div class="ambi-empty">Start typing to search your saved pages.</div>'

  header.append(title, input)
  panel.append(header, results)
  backdrop.append(panel)
  shadowRoot.append(style, backdrop)
  document.documentElement.append(root)

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      closeSearchPanel()
    }
  })

  // Prevent clicks/mousedowns on the panel from blurring the input on sites
  // that re-capture focus on every pointerdown (e.g. Claude.ai, Linear).
  panel.addEventListener("click", (event) => {
    event.stopPropagation()
  })

  panel.addEventListener("mousedown", (event) => {
    event.stopPropagation()
  })

  input.addEventListener("input", () => {
    scheduleSearch(input.value)
  })

  // Stop ALL keyboard events from bubbling out of the shadow root.
  // Sites like Claude.ai attach document-level keydown listeners that steal
  // focus from any non-native input. Calling stopPropagation here keeps
  // keystrokes inside the shadow DOM where they belong.
  input.addEventListener("keydown", (event) => {
    event.stopPropagation()
    if (event.key === "Escape") {
      closeSearchPanel()
    }
  })

  input.addEventListener("keyup", (event) => {
    event.stopPropagation()
  })

  input.addEventListener("keypress", (event) => {
    event.stopPropagation()
  })


  ambiPanelElements = {
    root,
    shadowRoot,
    backdrop,
    input,
    results
  }

  return ambiPanelElements
}

function renderStatus(message) {
  const { results } = ensureSearchPanel()
  results.innerHTML = `<div class="ambi-status">${escapeHtml(message)}</div>`
}

function renderResults(responsePayload, filteredItems = null) {
  const { results } = ensureSearchPanel()

  // Always persist the full payload for cluster-filter toggle
  if (filteredItems === null) {
    lastSearchPayload = responsePayload
  }

  const isFiltered = filteredItems !== null
  const items = isFiltered ? filteredItems : (responsePayload.results || [])

  if (!items.length) {
    results.innerHTML = '<div class="ambi-empty">No matching pages yet.</div>'
    return
  }

  results.innerHTML = ""

  // Global set of URLs already shown — prevents related items from repeating
  const shownRelatedUrls = new Set(items.map(i => i.url).filter(Boolean))

  if (responsePayload.context_label) {
    const displayLabel = generateContextLabel(responsePayload.context_label, items)
    const header = document.createElement("div")
    header.className = isFiltered
      ? "ambi-context-header ambi-context-header--active"
      : "ambi-context-header"
    header.textContent = isFiltered
      ? `Showing: ${displayLabel}`
      : `You've been exploring: ${displayLabel}`
    header.title = isFiltered ? "Click to show all results" : "Click to filter by this topic"
    header.addEventListener("click", () => {
      if (isFiltered) {
        renderResults(lastSearchPayload, null)
      } else {
        // Filter to items in the dominant cluster (items that have related siblings)
        let clusterItems = (lastSearchPayload.results || []).filter(r => r.related && r.related.length > 0)
        if (clusterItems.length < 2) {
          clusterItems = (lastSearchPayload.results || []).slice(0, 4)
        }
        renderResults(lastSearchPayload, clusterItems)
      }
    })
    results.append(header)
  }

  for (const item of items) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "ambi-result"
    button.innerHTML = `
      <span class="ambi-result-title">${escapeHtml(item.title || "Untitled page")}</span>
      <span class="ambi-result-snippet">${escapeHtml(item.snippet || "")}</span>
      <span class="ambi-result-footer">
        <span class="ambi-result-url">${escapeHtml(truncateUrl(item.url || ""))}</span>
        <span class="ambi-result-meta">${escapeHtml(item.domain || "unknown")} • ${escapeHtml(formatTimeSpent(item.total_time_spent || 0))}</span>
      </span>
    `

    button.addEventListener("click", () => {
      safeSendMessage({
        type: OPEN_SEARCH_RESULT_MESSAGE,
        url: item.url
      })
      closeSearchPanel()
    })

    results.append(button)

    // Deduplicated related items: skip already-shown URLs, max 2 per result
    const related = (item.related || [])
      .filter(r => r.url && !shownRelatedUrls.has(r.url))
      .slice(0, 2)

    for (const r of related) {
      shownRelatedUrls.add(r.url)
    }

    if (related.length > 0) {
      const relatedContainer = document.createElement("div")
      relatedContainer.className = "ambi-related"

      const relatedLabel = document.createElement("span")
      relatedLabel.className = "ambi-related-label"
      relatedLabel.textContent = "Related from same thread"
      relatedContainer.append(relatedLabel)

      for (const rel of related) {
        const relButton = document.createElement("button")
        relButton.type = "button"
        relButton.className = "ambi-related-item"
        relButton.innerHTML = `
          <span class="ambi-related-title">${escapeHtml(rel.title || "Untitled page")}</span>
          <span class="ambi-related-url">${escapeHtml(truncateUrl(rel.url || ""))}</span>
        `
        relButton.addEventListener("click", () => {
          safeSendMessage({
            type: OPEN_SEARCH_RESULT_MESSAGE,
            url: rel.url
          })
          closeSearchPanel()
        })
        relatedContainer.append(relButton)
      }

      results.append(relatedContainer)
    }
  }
}

function scheduleSearch(query) {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
  }

  const trimmedQuery = query.trim()

  if (!trimmedQuery) {
    renderStatus("Start typing to search your saved pages.")
    return
  }

  renderStatus("Searching...")

  searchDebounceTimer = window.setTimeout(async () => {
    if (!isExtensionContextValid()) {
      renderStatus("Extension was reloaded — please refresh this page.")
      return
    }
    try {
      const response = await chrome.runtime.sendMessage({
        type: SEARCH_QUERY_MESSAGE,
        query: trimmedQuery
      })

      if (!response?.ok) {
        throw new Error(response?.error || "Search request failed.")
      }

      renderResults(response.payload || { results: [] })
    } catch (error) {
      renderStatus(`Unable to reach Ambi backend. ${error.message}`)
    }
  }, 180)
}

function openSearchPanel() {
  const { backdrop, input } = ensureSearchPanel()
  backdrop.dataset.open = "true"
  input.focus()
  input.select()
  scheduleSearch(input.value)
}

function closeSearchPanel() {
  if (!ambiPanelElements) {
    return
  }

  ambiPanelElements.backdrop.dataset.open = "false"
}

function toggleSearchPanel() {
  const { backdrop } = ensureSearchPanel()

  if (backdrop.dataset.open === "true") {
    closeSearchPanel()
    return
  }

  openSearchPanel()
}

// ── Twitter / X bookmark scroll capture ──────────────────────────────────────

const twitterIngestedUrls = new Set()
let twitterIntersectionObserver = null
let twitterMutationObserver = null

function isOnTwitterBookmarks() {
  const { hostname, pathname } = window.location
  return (hostname === "twitter.com" || hostname === "x.com") && pathname.startsWith("/i/bookmarks")
}

function extractTweetData(article) {
  const statusLink = article.querySelector('a[href*="/status/"]')
  if (!statusLink) return null

  const url = statusLink.href
  if (!url || twitterIngestedUrls.has(url)) return null

  const textEl = article.querySelector('[data-testid="tweetText"]')
  const text = textEl ? (textEl.innerText || textEl.textContent || "").trim() : ""

  const authorMatch = url.match(/(?:twitter|x)\.com\/([^/]+)\/status\//)
  const author = authorMatch ? `@${authorMatch[1]}` : ""

  const timeEl = article.querySelector("time")
  const timestamp = timeEl?.getAttribute("datetime") || new Date().toISOString()

  const title = author
    ? `${author}: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`
    : text.slice(0, 100) || "Tweet"

  return { url, title, text: text || title, timestamp }
}

function ingestTweetItem(article) {
  const data = extractTweetData(article)
  if (!data) return

  twitterIngestedUrls.add(data.url)
  safeSendMessage({
    type: INGEST_ITEM_MESSAGE,
    payload: {
      url: data.url,
      title: data.title,
      text: data.text,
      timestamp: data.timestamp,
      time_spent: 30_000
    }
  })
}

function observeNewTweets() {
  document.querySelectorAll('article[data-testid="tweet"]').forEach(article => {
    if (article.dataset.ambiWatched) return
    article.dataset.ambiWatched = "1"
    twitterIntersectionObserver.observe(article)
  })
}

function setupTwitterBookmarkCapture() {
  if (!isOnTwitterBookmarks()) return
  if (twitterIntersectionObserver) return

  twitterIntersectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) ingestTweetItem(entry.target)
    }
  }, { threshold: 0.5 })

  twitterMutationObserver = new MutationObserver(observeNewTweets)
  twitterMutationObserver.observe(document.body, { childList: true, subtree: true })

  observeNewTweets()
}

function teardownTwitterBookmarkCapture() {
  twitterIntersectionObserver?.disconnect()
  twitterMutationObserver?.disconnect()
  twitterIntersectionObserver = null
  twitterMutationObserver = null
}

function handleUrlChange() {
  if (isOnTwitterBookmarks()) {
    setupTwitterBookmarkCapture()
  } else {
    teardownTwitterBookmarkCapture()
  }
}

// ─────────────────────────────────────────────────────────────────────────────

wrapHistoryMethod("pushState")
wrapHistoryMethod("replaceState")

window.addEventListener("load", () => { schedulePageSnapshot(); handleUrlChange() })
window.addEventListener("popstate", () => { schedulePageSnapshot(); handleUrlChange() })
window.addEventListener("hashchange", () => { schedulePageSnapshot(); handleUrlChange() })

const titleObserver = new MutationObserver(() => {
  schedulePageSnapshot()
})

if (document.head) {
  titleObserver.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true
  })
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === TOGGLE_SEARCH_PANEL_MESSAGE) {
    toggleSearchPanel()
  }
})

schedulePageSnapshot()
