const PAGE_METADATA_MESSAGE = "PAGE_METADATA"
const SEARCH_QUERY_MESSAGE = "SEARCH_QUERY"
const OPEN_SEARCH_RESULT_MESSAGE = "OPEN_SEARCH_RESULT"
const TOGGLE_SEARCH_PANEL_MESSAGE = "TOGGLE_SEARCH_PANEL"
const INGEST_ITEM_MESSAGE = "INGEST_ITEM"
const DELETE_ITEM_MESSAGE = "DELETE_ITEM"
const OPEN_PANEL_MESSAGE = "OPEN_PANEL"
const PAGE_SNAPSHOT_DEBOUNCE_MS = 300
const MAX_TEXT_LENGTH = 50_000

const CATEGORY_EMOJIS = {
  All: "🌐", AI: "🤖", Dev: "⚙️", Education: "📚",
  Social: "💬", Productivity: "🗂️", Entertainment: "🎬", News: "📰", Other: "📁"
}
const CATEGORY_ORDER = ["All", "AI", "Dev", "Education", "Social", "Productivity", "Entertainment", "News", "Other"]
const LINKS_MAX_PER_DOMAIN = 8
const AI_HOSTNAMES = ["claude.ai", "chat.openai.com", "gemini.google.com", "perplexity.ai"]

let lastPageMetadata = { title: "", url: "", text: "" }
let searchDebounceTimer = null
let pageSnapshotTimer = null
let ambiPanelElements = null
let lastSearchPayload = null

let currentPanelMode = "context"
let linksActiveCategory = "All"
let linksExpandedDomains = new Set()
let linksSearchQuery = ""
let linksFocusIndex = -1
let linksVisibleRows = []

function normalizeText(text = "") {
  return text
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

function isExtensionContextValid() {
  try { return !!chrome.runtime?.id } catch { return false }
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
    if (typeof Readability !== "function") throw new Error("Readability not available.")
    const documentClone = document.cloneNode(true)
    documentClone.querySelectorAll("script, style, noscript, template, svg, math").forEach(el => el.remove())
    const article = new Readability(documentClone).parse()
    const extractedText = normalizeText(article?.textContent || "")
    if (extractedText) {
      return { title: article?.title || document.title, text: extractedText.slice(0, MAX_TEXT_LENGTH) }
    }
  } catch {}
  return {
    title: document.title,
    text: normalizeText(document.body?.innerText || "").slice(0, MAX_TEXT_LENGTH)
  }
}

function isTrackablePage() {
  const url = window.location.href
  if (!url || url === "about:blank" || url === "about:newtab") return false
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://")) return false
  if (url.startsWith("about:") || url.startsWith("data:")) return false
  const bodyText = document.body?.innerText?.trim() || ""
  const hasTitle = document.title?.trim().length > 0
  const hasContent = bodyText.length > 20
  return hasTitle || hasContent
}

function sendPageMetadata() {
  if (!isTrackablePage()) return
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
  ) return
  lastPageMetadata = nextPageMetadata
  safeSendMessage({ type: PAGE_METADATA_MESSAGE, payload: nextPageMetadata })
}

function schedulePageSnapshot() {
  if (pageSnapshotTimer) clearTimeout(pageSnapshotTimer)
  pageSnapshotTimer = window.setTimeout(() => sendPageMetadata(), PAGE_SNAPSHOT_DEBOUNCE_MS)
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
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`
}

function truncateUrl(url, maxLength = 64) {
  if (!url || url.length <= maxLength) return url
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
  const titleWords = topItems.slice(0, 3)
    .flatMap(item => (item.title || "").toLowerCase().split(/[\s\-–_\/|,.()\[\]"']+/))
    .filter(w => w.length > 3 && !LABEL_GENERIC_WORDS.has(w))
  if (titleWords.length >= 3) {
    const freq = {}
    for (const w of titleWords) freq[w] = (freq[w] || 0) + 1
    const candidates = Object.entries(freq)
      .sort(([a, fa], [b, fb]) => fb - fa || b.length - a.length)
      .slice(0, 4)
      .map(([w]) => toTitleCase(w))
    if (candidates.length >= 2) return candidates.join(" ")
  }
  const parts = (contextLabel || "")
    .split(/\s*[\/\|\-–]\s*/)
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length > 1 && !LABEL_GENERIC_WORDS.has(w))
  if (parts.length >= 1) return parts.slice(0, 5).map(toTitleCase).join(" ")
  return (contextLabel || "").replace(/\b\w/g, c => c.toUpperCase())
}

// ── Clipboard capture ─────────────────────────────────────────────────────────

const CLIPBOARD_SENSITIVE_PATTERNS = [
  /\b\d[\d\s\-]{11,17}\d\b/,
  /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/,
  /(sk-|ghp_|xoxb-|glpat-|Bearer\s+)\S{10,}/i,
  /\b(password|passwd|secret|api[_\s]?key)\s*[:=]\s*\S+/i
]

function isUsefulClipboardText(text) {
  const trimmed = text.trim()
  if (trimmed.length < 40 || trimmed.length > 4000) return false
  if (!/\s/.test(trimmed)) return false
  if (/^https?:\/\/\S+$/.test(trimmed)) return false
  const alphaCount = (trimmed.match(/[a-zA-Z]/g) || []).length
  if (alphaCount / trimmed.length < 0.4) return false
  for (const pattern of CLIPBOARD_SENSITIVE_PATTERNS) {
    if (pattern.test(trimmed)) return false
  }
  return true
}

function handleClipboardCopy(event) {
  if (!isExtensionContextValid()) return
  const text = event.clipboardData?.getData("text/plain") || ""
  if (!isUsefulClipboardText(text)) return
  const hostname = window.location.hostname || "unknown"
  const title = `Copied from ${document.title || hostname}`
  safeSendMessage({
    type: INGEST_ITEM_MESSAGE,
    payload: {
      url: `clipboard://${hostname}/${Date.now()}`,
      title,
      text: text.trim(),
      timestamp: new Date().toISOString(),
      time_spent: 30_000
    }
  })
}

document.addEventListener("copy", handleClipboardCopy)

// ── Links panel helpers ───────────────────────────────────────────────────────

function isCardWorthy(link) {
  const ageDays = (Date.now() - link.lastVisited) / (1000 * 60 * 60 * 24)
  if (link.pinned) return true
  if (link.visits >= 5) return true
  if (ageDays <= 7 && link.visits >= 2) return true
  return false
}

function scoreLink(link) {
  return (link.visits * 0.4) + ((link.lastVisited / 1e10) * 0.6)
}

function cleanLinkUrl(url) {
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname}`.replace(/\/$/, "")
  } catch { return url }
}

function getLinkHostname(url) {
  try { return new URL(url).hostname } catch { return url }
}

async function getAllLinks() {
  const stored = await chrome.storage.local.get("links")
  const all = stored.links || {}
  return Object.entries(all).flatMap(([cat, items]) =>
    (items || []).map(l => ({ ...l, category: cat }))
  )
}

function groupByDomain(links) {
  const groups = new Map()
  for (const link of links) {
    const domain = getLinkHostname(link.url)
    if (!groups.has(domain)) groups.set(domain, [])
    groups.get(domain).push(link)
  }
  return groups
}

function sortedGroupEntries(groups) {
  return [...groups.entries()].sort((a, b) => {
    const maxA = Math.max(...a[1].map(scoreLink))
    const maxB = Math.max(...b[1].map(scoreLink))
    return maxB - maxA
  })
}

function dedupLinks(links) {
  const seen = new Map()
  for (const l of links) {
    const key = cleanLinkUrl(l.url)
    if (!seen.has(key) || l.visits > seen.get(key).visits) seen.set(key, l)
  }
  return [...seen.values()]
}

// ── Panel DOM setup ───────────────────────────────────────────────────────────

function ensurePanel() {
  if (ambiPanelElements) return ambiPanelElements

  const root = document.createElement("div")
  root.id = "ambi-search-root"
  const shadowRoot = root.attachShadow({ mode: "open" })

  const styleLink = document.createElement("link")
  styleLink.rel = "stylesheet"
  styleLink.href = chrome.runtime.getURL("panel.css")

  const backdrop = document.createElement("div")
  backdrop.className = "ambi-backdrop"
  backdrop.dataset.open = "false"
  backdrop.dataset.mode = "context"

  const panel = document.createElement("div")
  panel.className = "ambi-panel"

  // Tab switcher
  const tabsEl = document.createElement("div")
  tabsEl.className = "ambi-tabs"

  const contextTabBtn = document.createElement("button")
  contextTabBtn.type = "button"
  contextTabBtn.className = "ambi-tab"
  contextTabBtn.dataset.tab = "context"
  contextTabBtn.textContent = "Context"

  const linksTabBtn = document.createElement("button")
  linksTabBtn.type = "button"
  linksTabBtn.className = "ambi-tab"
  linksTabBtn.dataset.tab = "links"
  linksTabBtn.textContent = "Links"

  tabsEl.append(contextTabBtn, linksTabBtn)

  // ── Context view ──
  const contextView = document.createElement("div")
  contextView.className = "ambi-view ambi-view--context"

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
  contextView.append(header, results)

  // ── Links view ──
  const linksView = document.createElement("div")
  linksView.className = "ambi-view ambi-view--links"

  const searchWrap = document.createElement("div")
  searchWrap.className = "ambi-links-search-wrap"

  const searchIcon = document.createElement("span")
  searchIcon.className = "ambi-links-search-icon"
  searchIcon.textContent = "⌕"

  const linksInput = document.createElement("input")
  linksInput.className = "ambi-links-input"
  linksInput.type = "text"
  linksInput.placeholder = "Search your links..."
  linksInput.autocomplete = "off"
  linksInput.spellcheck = false

  const shortcutHint = document.createElement("kbd")
  shortcutHint.className = "ambi-links-shortcut"
  shortcutHint.textContent = "⌘⇧L"

  searchWrap.append(searchIcon, linksInput, shortcutHint)

  const catTabs = document.createElement("div")
  catTabs.className = "ambi-cat-tabs"

  const linksBody = document.createElement("div")
  linksBody.className = "ambi-links-body"

  const linksFooter = document.createElement("div")
  linksFooter.className = "ambi-links-footer"

  const countEl = document.createElement("span")
  countEl.className = "ambi-links-count"
  countEl.textContent = "0 links captured"

  const footerActions = document.createElement("div")
  footerActions.className = "ambi-footer-actions"

  const copyBtn = document.createElement("button")
  copyBtn.type = "button"
  copyBtn.className = "ambi-copy-btn"
  copyBtn.textContent = "Copy card"

  const injectBtn = document.createElement("button")
  injectBtn.type = "button"
  injectBtn.className = "ambi-inject-btn"
  injectBtn.textContent = "↑ Inject context"

  footerActions.append(copyBtn, injectBtn)
  linksFooter.append(countEl, footerActions)
  linksView.append(searchWrap, catTabs, linksBody, linksFooter)

  panel.append(tabsEl, contextView, linksView)
  backdrop.append(panel)
  shadowRoot.append(styleLink, backdrop)
  document.documentElement.append(root)

  // ── Context view event listeners ──
  backdrop.addEventListener("click", event => {
    if (event.target === backdrop) closePanel()
  })
  panel.addEventListener("click", event => event.stopPropagation())
  panel.addEventListener("mousedown", event => event.stopPropagation())

  input.addEventListener("input", () => scheduleSearch(input.value))
  input.addEventListener("keydown", event => {
    event.stopPropagation()
    if (event.key === "Escape") closePanel()
  })
  input.addEventListener("keyup", event => event.stopPropagation())
  input.addEventListener("keypress", event => event.stopPropagation())

  // ── Links view event listeners ──
  linksInput.addEventListener("input", () => {
    linksSearchQuery = linksInput.value
    void renderLinksPanel()
  })
  linksInput.addEventListener("keydown", event => {
    event.stopPropagation()
    if (event.key === "Escape") closePanel()
  })
  linksInput.addEventListener("keyup", event => event.stopPropagation())
  linksInput.addEventListener("keypress", event => event.stopPropagation())

  backdrop.addEventListener("keydown", event => {
    if (currentPanelMode === "links") handleLinksKeydown(event)
  })

  copyBtn.addEventListener("click", () => void copyCard())
  injectBtn.addEventListener("click", () => void injectContext())

  // ── Tab switcher ──
  contextTabBtn.addEventListener("click", () => switchMode("context"))
  linksTabBtn.addEventListener("click", () => switchMode("links"))

  ambiPanelElements = {
    root, shadowRoot, backdrop, panel,
    input, results,
    linksInput, catTabs, linksBody, countEl
  }

  return ambiPanelElements
}

// ── Panel open / close / switch ───────────────────────────────────────────────

function openPanel(mode) {
  const { backdrop, input, linksInput } = ensurePanel()
  currentPanelMode = mode
  backdrop.dataset.open = "true"
  backdrop.dataset.mode = mode
  if (mode === "context") {
    input.focus()
    input.select()
    scheduleSearch(input.value)
  } else {
    linksExpandedDomains = new Set()
    linksFocusIndex = -1
    void renderLinksPanel()
    linksInput.focus()
  }
}

function closePanel() {
  if (!ambiPanelElements) return
  ambiPanelElements.backdrop.dataset.open = "false"
}

function switchMode(mode) {
  const { backdrop, input, linksInput } = ensurePanel()
  currentPanelMode = mode
  backdrop.dataset.mode = mode
  if (mode === "context") {
    input.focus()
    input.select()
    scheduleSearch(input.value)
  } else {
    linksExpandedDomains = new Set()
    linksFocusIndex = -1
    void renderLinksPanel()
    linksInput.focus()
  }
}

function handleOpenPanel(requestedMode) {
  const { backdrop } = ensurePanel()
  const isOpen = backdrop.dataset.open === "true"
  if (!isOpen) { openPanel(requestedMode); return }
  if (currentPanelMode === requestedMode) { closePanel(); return }
  switchMode(requestedMode)
}

// ── Context panel rendering (unchanged logic) ─────────────────────────────────

function renderStatus(message) {
  const { results } = ensurePanel()
  results.innerHTML = `<div class="ambi-status">${escapeHtml(message)}</div>`
}

function renderResults(responsePayload, filteredItems = null) {
  const { results } = ensurePanel()
  if (filteredItems === null) lastSearchPayload = responsePayload
  const isFiltered = filteredItems !== null
  const items = isFiltered ? filteredItems : (responsePayload.results || [])

  if (!items.length) {
    results.innerHTML = '<div class="ambi-empty">No matching pages yet.</div>'
    return
  }

  results.innerHTML = ""
  const shownRelatedUrls = new Set(items.map(i => i.url).filter(Boolean))

  if (responsePayload.context_label) {
    const displayLabel = generateContextLabel(responsePayload.context_label, items)
    const headerEl = document.createElement("div")
    headerEl.className = isFiltered
      ? "ambi-context-header ambi-context-header--active"
      : "ambi-context-header"
    headerEl.textContent = isFiltered
      ? `Showing: ${displayLabel}`
      : `You've been exploring: ${displayLabel}`
    headerEl.title = isFiltered ? "Click to show all results" : "Click to filter by this topic"
    headerEl.addEventListener("click", () => {
      if (isFiltered) {
        renderResults(lastSearchPayload, null)
      } else {
        let clusterItems = (lastSearchPayload.results || []).filter(r => r.related && r.related.length > 0)
        if (clusterItems.length < 2) clusterItems = (lastSearchPayload.results || []).slice(0, 4)
        renderResults(lastSearchPayload, clusterItems)
      }
    })
    results.append(headerEl)
  }

  for (const item of items) {
    const row = document.createElement("div")
    row.className = "ambi-result-row"

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
      safeSendMessage({ type: OPEN_SEARCH_RESULT_MESSAGE, url: item.url })
      closePanel()
    })

    const deleteWrap = document.createElement("div")
    deleteWrap.className = "ambi-delete-wrap"

    const deleteBtn = document.createElement("button")
    deleteBtn.type = "button"
    deleteBtn.className = "ambi-delete-btn"
    deleteBtn.textContent = "×"

    const deleteTooltip = document.createElement("span")
    deleteTooltip.className = "ambi-delete-tooltip"
    deleteTooltip.textContent = "Permanently delete this?"

    deleteBtn.addEventListener("click", async e => {
      e.stopPropagation()
      deleteBtn.classList.add("ambi-delete-btn--deleting")
      deleteBtn.textContent = "○"
      const fadeOut = () => {
        row.style.transition = "opacity 200ms ease"
        row.style.opacity = "0"
        setTimeout(() => row.remove(), 210)
      }
      try {
        const response = await chrome.runtime.sendMessage({ type: DELETE_ITEM_MESSAGE, url: item.url })
        if (response?.ok || response?.status === 404) {
          fadeOut()
        } else {
          deleteBtn.classList.remove("ambi-delete-btn--deleting")
          deleteBtn.textContent = "×"
        }
      } catch {
        deleteBtn.classList.remove("ambi-delete-btn--deleting")
        deleteBtn.textContent = "×"
      }
    })

    deleteWrap.append(deleteBtn, deleteTooltip)
    row.append(button, deleteWrap)
    results.append(row)

    const related = (item.related || [])
      .filter(r => r.url && !shownRelatedUrls.has(r.url))
      .slice(0, 2)

    for (const r of related) shownRelatedUrls.add(r.url)

    if (related.length > 0) {
      const relatedContainer = document.createElement("div")
      relatedContainer.className = "ambi-related"

      const relatedLabel = document.createElement("span")
      relatedLabel.className = "ambi-related-label"
      relatedLabel.textContent = "Related from same thread"
      relatedContainer.append(relatedLabel)

      for (const rel of related) {
        const relRow = document.createElement("div")
        relRow.className = "ambi-related-row"

        const relButton = document.createElement("button")
        relButton.type = "button"
        relButton.className = "ambi-related-item"
        relButton.innerHTML = `
          <span class="ambi-related-title">${escapeHtml(rel.title || "Untitled page")}</span>
          <span class="ambi-related-url">${escapeHtml(truncateUrl(rel.url || ""))}</span>
        `
        relButton.addEventListener("click", () => {
          safeSendMessage({ type: OPEN_SEARCH_RESULT_MESSAGE, url: rel.url })
          closePanel()
        })

        const relDeleteWrap = document.createElement("div")
        relDeleteWrap.className = "ambi-delete-wrap"
        relDeleteWrap.style.marginRight = "6px"

        const relDeleteBtn = document.createElement("button")
        relDeleteBtn.type = "button"
        relDeleteBtn.className = "ambi-delete-btn"
        relDeleteBtn.textContent = "×"

        const relDeleteTooltip = document.createElement("span")
        relDeleteTooltip.className = "ambi-delete-tooltip"
        relDeleteTooltip.textContent = "Permanently delete this?"

        relDeleteBtn.addEventListener("click", async e => {
          e.stopPropagation()
          relDeleteBtn.classList.add("ambi-delete-btn--deleting")
          relDeleteBtn.textContent = "○"
          try {
            const response = await chrome.runtime.sendMessage({ type: DELETE_ITEM_MESSAGE, url: rel.url })
            if (response?.ok || response?.status === 404) {
              relRow.style.transition = "opacity 200ms ease"
              relRow.style.opacity = "0"
              setTimeout(() => relRow.remove(), 210)
            } else {
              relDeleteBtn.classList.remove("ambi-delete-btn--deleting")
              relDeleteBtn.textContent = "×"
            }
          } catch {
            relDeleteBtn.classList.remove("ambi-delete-btn--deleting")
            relDeleteBtn.textContent = "×"
          }
        })

        relDeleteWrap.append(relDeleteBtn, relDeleteTooltip)
        relRow.append(relButton, relDeleteWrap)
        relatedContainer.append(relRow)
      }

      results.append(relatedContainer)
    }
  }
}

function scheduleSearch(query) {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
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
      const response = await chrome.runtime.sendMessage({ type: SEARCH_QUERY_MESSAGE, query: trimmedQuery })
      if (!response?.ok) throw new Error(response?.error || "Search request failed.")
      renderResults(response.payload || { results: [] })
    } catch (error) {
      renderStatus(`Unable to reach Ambi backend. ${error.message}`)
    }
  }, 180)
}

// ── Links panel rendering ─────────────────────────────────────────────────────

async function renderLinksPanel() {
  const { catTabs, linksBody, countEl } = ensurePanel()

  const allLinks = await getAllLinks()
  const cardWorthy = dedupLinks(allLinks.filter(isCardWorthy))

  // Category tab counts
  const countByCategory = { All: cardWorthy.length }
  for (const cat of CATEGORY_ORDER.slice(1)) {
    countByCategory[cat] = cardWorthy.filter(l => l.category === cat).length
  }

  // Render category tabs
  catTabs.innerHTML = ""
  for (const cat of CATEGORY_ORDER) {
    const count = countByCategory[cat] || 0
    if (cat !== "All" && count === 0) continue
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "ambi-cat-tab" + (cat === linksActiveCategory ? " ambi-cat-tab--active" : "")
    btn.textContent = `${CATEGORY_EMOJIS[cat] || ""} ${cat} ${count}`
    btn.addEventListener("click", () => {
      linksActiveCategory = cat
      linksExpandedDomains = new Set()
      linksFocusIndex = -1
      void renderLinksPanel()
    })
    catTabs.append(btn)
  }

  // Filter by category + search
  let displayed = linksActiveCategory === "All"
    ? cardWorthy
    : cardWorthy.filter(l => l.category === linksActiveCategory)

  if (linksSearchQuery) {
    const q = linksSearchQuery.toLowerCase()
    displayed = displayed.filter(l =>
      (l.title || "").toLowerCase().includes(q) ||
      (l.url || "").toLowerCase().includes(q)
    )
  }

  const pinned = displayed.filter(l => l.pinned)
  const unpinned = displayed.filter(l => !l.pinned)
  const grouped = groupByDomain(unpinned)
  const sortedGroups = sortedGroupEntries(grouped)

  // Auto-expand first domain if nothing is expanded in this group
  if (sortedGroups.length > 0) {
    const hasExpanded = sortedGroups.some(([d]) => linksExpandedDomains.has(d))
    if (!hasExpanded) linksExpandedDomains.add(sortedGroups[0][0])
  }

  linksBody.innerHTML = ""
  linksVisibleRows = []

  // Pinned section
  if (pinned.length > 0) {
    const pinnedLabel = document.createElement("span")
    pinnedLabel.className = "ambi-pinned-label"
    pinnedLabel.textContent = "Pinned"
    linksBody.append(pinnedLabel)
    for (const link of pinned) {
      const subRow = buildSubLinkRow(link, true)
      linksVisibleRows.push({ el: subRow, type: "link", link })
      linksBody.append(subRow)
    }
  }

  // Accordion
  for (const [domain, domainLinks] of sortedGroups) {
    const isExpanded = linksExpandedDomains.has(domain)
    const { domainRow, headerEl } = buildDomainRow(domain, domainLinks, isExpanded)
    linksVisibleRows.push({ el: headerEl, type: "domain", domain })
    linksBody.append(domainRow)

    if (isExpanded) {
      const sorted = [...domainLinks].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1
        if (!a.pinned && b.pinned) return 1
        return scoreLink(b) - scoreLink(a)
      })
      const visible = sorted.slice(0, LINKS_MAX_PER_DOMAIN)
      const hidden = sorted.slice(LINKS_MAX_PER_DOMAIN)

      for (let i = 0; i < visible.length; i++) {
        const link = visible[i]
        const isLast = i === visible.length - 1 && hidden.length === 0
        const subRow = buildSubLinkRow(link, false, isLast)
        linksVisibleRows.push({ el: subRow, type: "link", link })
        domainRow.append(subRow)
      }

      if (hidden.length > 0) {
        const showMore = document.createElement("button")
        showMore.type = "button"
        showMore.className = "ambi-show-more"
        showMore.textContent = `Show ${hidden.length} more`
        showMore.addEventListener("click", () => {
          for (const link of hidden) {
            const subRow = buildSubLinkRow(link, false, false)
            domainRow.insertBefore(subRow, showMore)
          }
          showMore.remove()
        })
        domainRow.append(showMore)
      }
    }
  }

  if (displayed.length === 0) {
    const empty = document.createElement("div")
    empty.className = "ambi-links-empty"
    empty.textContent = linksSearchQuery ? "No links match your search." : "No links yet. Browse around!"
    linksBody.append(empty)
  }

  countEl.textContent = `${cardWorthy.length} links captured`
  updateLinksFocus(-1)
}

function buildDomainRow(domain, links, isExpanded) {
  const domainRow = document.createElement("div")
  domainRow.className = "ambi-domain-row" + (isExpanded ? " ambi-domain-row--expanded" : "")

  const headerEl = document.createElement("div")
  headerEl.className = "ambi-domain-header"
  headerEl.setAttribute("role", "button")
  headerEl.tabIndex = -1

  const favicon = document.createElement("img")
  favicon.className = "ambi-domain-favicon"
  favicon.src = links[0]?.favicon || `https://www.google.com/s2/favicons?domain=${domain}&sz=32`
  favicon.onerror = function () {
    const fallback = document.createElement("div")
    fallback.className = "ambi-domain-favicon-fallback"
    fallback.textContent = domain[0]?.toUpperCase() || "?"
    this.replaceWith(fallback)
  }

  const domainName = document.createElement("span")
  domainName.className = "ambi-domain-name"
  domainName.textContent = domain

  const countEl = document.createElement("span")
  countEl.className = "ambi-domain-count"
  countEl.textContent = links.length

  const arrow = document.createElement("span")
  arrow.className = "ambi-domain-arrow"
  arrow.textContent = "▶"

  headerEl.append(favicon, domainName, countEl, arrow)
  domainRow.append(headerEl)

  headerEl.addEventListener("click", () => toggleDomain(domain, domainRow))

  return { domainRow, headerEl }
}

function toggleDomain(domain, domainRow) {
  if (linksExpandedDomains.has(domain)) {
    linksExpandedDomains.delete(domain)
  } else {
    linksExpandedDomains.add(domain)
  }
  void renderLinksPanel()
}

function buildSubLinkRow(link, isPinnedSection, isLast = false) {
  const row = document.createElement("div")
  row.className = "ambi-sub-link-row"

  const subLinks = document.createElement("div")
  subLinks.className = "ambi-sub-links"
  if (!isPinnedSection) row.style.paddingLeft = "28px"

  const treeIndicator = document.createElement("span")
  treeIndicator.className = "ambi-sub-link-tree"
  treeIndicator.textContent = isLast ? "└" : "├"

  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = "ambi-sub-link-btn"
  btn.addEventListener("click", () => {
    safeSendMessage({ type: OPEN_SEARCH_RESULT_MESSAGE, url: link.url })
    closePanel()
  })

  if (isPinnedSection) {
    const fav = document.createElement("img")
    fav.className = "ambi-domain-favicon"
    fav.src = link.favicon || `https://www.google.com/s2/favicons?domain=${getLinkHostname(link.url)}&sz=32`
    fav.onerror = function () {
      const fallback = document.createElement("div")
      fallback.className = "ambi-domain-favicon-fallback"
      fallback.textContent = getLinkHostname(link.url)[0]?.toUpperCase() || "?"
      this.replaceWith(fallback)
    }
    btn.append(fav)
  }

  if (link.pinned && !isPinnedSection) {
    const dot = document.createElement("span")
    dot.className = "ambi-pinned-dot"
    btn.append(dot)
  }

  const titleEl = document.createElement("span")
  titleEl.className = "ambi-sub-link-title"
  titleEl.textContent = link.title || cleanLinkUrl(link.url)

  const domainEl = document.createElement("span")
  domainEl.className = "ambi-sub-link-domain"
  domainEl.textContent = getLinkHostname(link.url)

  btn.append(titleEl, domainEl)

  const actions = document.createElement("div")
  actions.className = "ambi-sub-link-actions"

  const pinBtn = document.createElement("button")
  pinBtn.type = "button"
  pinBtn.className = "ambi-sub-action-btn" + (link.pinned ? " ambi-sub-action-btn--pinned" : "")
  pinBtn.title = link.pinned ? "Unpin" : "Pin"
  pinBtn.textContent = "📌"
  pinBtn.addEventListener("click", e => {
    e.stopPropagation()
    void togglePin(link)
  })

  const deleteBtn = document.createElement("button")
  deleteBtn.type = "button"
  deleteBtn.className = "ambi-sub-action-btn ambi-sub-action-btn--delete"
  deleteBtn.title = "Remove from links"
  deleteBtn.textContent = "×"
  deleteBtn.addEventListener("click", e => {
    e.stopPropagation()
    void deleteLink(link, row)
  })

  actions.append(pinBtn, deleteBtn)

  if (!isPinnedSection) row.append(treeIndicator)
  row.append(btn, actions)

  return row
}

async function togglePin(link) {
  const stored = await chrome.storage.local.get("links")
  const links = stored.links || {}
  const key = cleanLinkUrl(link.url)
  for (const [cat, items] of Object.entries(links)) {
    const idx = items.findIndex(l => cleanLinkUrl(l.url) === key)
    if (idx !== -1) {
      links[cat][idx] = { ...items[idx], pinned: !items[idx].pinned }
      await chrome.storage.local.set({ links })
      void renderLinksPanel()
      return
    }
  }
}

async function deleteLink(link, rowEl) {
  rowEl.style.transition = "opacity 150ms ease"
  rowEl.style.opacity = "0"
  setTimeout(async () => {
    rowEl.remove()
    const stored = await chrome.storage.local.get("links")
    const links = stored.links || {}
    const key = cleanLinkUrl(link.url)
    for (const [cat, items] of Object.entries(links)) {
      const idx = items.findIndex(l => cleanLinkUrl(l.url) === key)
      if (idx !== -1) {
        links[cat].splice(idx, 1)
        await chrome.storage.local.set({ links })
        void renderLinksPanel()
        return
      }
    }
  }, 160)
}

// ── Keyboard navigation ───────────────────────────────────────────────────────

function updateLinksFocus(newIndex) {
  for (const { el } of linksVisibleRows) {
    el.classList.remove("ambi-domain-header--focused", "ambi-sub-link-row--focused")
  }
  linksFocusIndex = newIndex
  if (newIndex < 0 || newIndex >= linksVisibleRows.length) return
  const { el, type } = linksVisibleRows[newIndex]
  el.classList.add(type === "domain" ? "ambi-domain-header--focused" : "ambi-sub-link-row--focused")
  el.scrollIntoView({ block: "nearest" })
}

function handleLinksKeydown(event) {
  const { linksInput } = ensurePanel()

  if (event.key === "Escape") { event.preventDefault(); closePanel(); return }

  if (event.key === "ArrowDown") {
    event.preventDefault()
    updateLinksFocus(Math.min(linksFocusIndex + 1, linksVisibleRows.length - 1))
    return
  }

  if (event.key === "ArrowUp") {
    event.preventDefault()
    if (linksFocusIndex <= 0) { linksInput.focus(); updateLinksFocus(-1) }
    else updateLinksFocus(linksFocusIndex - 1)
    return
  }

  if (event.key === "ArrowRight" && linksFocusIndex >= 0) {
    event.preventDefault()
    const row = linksVisibleRows[linksFocusIndex]
    if (row?.type === "domain" && !linksExpandedDomains.has(row.domain)) {
      linksExpandedDomains.add(row.domain)
      void renderLinksPanel().then(() => updateLinksFocus(linksFocusIndex))
    }
    return
  }

  if (event.key === "ArrowLeft" && linksFocusIndex >= 0) {
    event.preventDefault()
    const row = linksVisibleRows[linksFocusIndex]
    if (row?.type === "domain" && linksExpandedDomains.has(row.domain)) {
      linksExpandedDomains.delete(row.domain)
      void renderLinksPanel().then(() => updateLinksFocus(linksFocusIndex))
    }
    return
  }

  if (event.key === "Enter" && linksFocusIndex >= 0) {
    event.preventDefault()
    const row = linksVisibleRows[linksFocusIndex]
    if (row?.type === "domain") {
      toggleDomain(row.domain)
      void renderLinksPanel().then(() => updateLinksFocus(linksFocusIndex))
    } else if (row?.type === "link") {
      safeSendMessage({ type: OPEN_SEARCH_RESULT_MESSAGE, url: row.link.url })
      closePanel()
    }
    return
  }

  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
    linksInput.focus()
  }
}

// ── Footer actions ────────────────────────────────────────────────────────────

async function copyCard() {
  const allLinks = await getAllLinks()
  const cardWorthy = dedupLinks(allLinks.filter(isCardWorthy))
  const grouped = groupByDomain(cardWorthy)
  const lines = []
  for (const [domain, links] of sortedGroupEntries(grouped)) {
    lines.push(domain)
    for (const l of links.sort((a, b) => scoreLink(b) - scoreLink(a))) {
      lines.push(`  ${l.title || cleanLinkUrl(l.url)} (${cleanLinkUrl(l.url)})`)
    }
  }
  try {
    await navigator.clipboard.writeText(lines.join("\n"))
    const { countEl } = ensurePanel()
    const prev = countEl.textContent
    countEl.textContent = "Copied ✓"
    setTimeout(() => { countEl.textContent = prev }, 1800)
  } catch {}
}

async function injectContext() {
  const allLinks = await getAllLinks()
  const cardWorthy = dedupLinks(allLinks.filter(isCardWorthy))
    .sort((a, b) => scoreLink(b) - scoreLink(a))

  const topLinks = cardWorthy.slice(0, 8)
    .map(l => `${l.title} (${cleanLinkUrl(l.url)})`).join(", ")

  const recentLinks = [...cardWorthy]
    .sort((a, b) => b.lastVisited - a.lastVisited)
  const recentDomains = [...new Set(recentLinks.map(l => getLinkHostname(l.url)))].slice(0, 3).join(", ")

  const context = `[Context: My key links — ${topLinks}. Recently active: ${recentDomains}.]`

  const isAi = AI_HOSTNAMES.some(h => window.location.hostname.includes(h))

  if (isAi) {
    const textarea = document.querySelector("textarea") ||
      document.querySelector('[contenteditable="true"][role="textbox"]') ||
      document.querySelector('[contenteditable="true"]')
    if (textarea) {
      textarea.focus()
      if (textarea.tagName === "TEXTAREA") {
        textarea.value = context + "\n" + textarea.value
        textarea.dispatchEvent(new Event("input", { bubbles: true }))
      } else {
        textarea.textContent = context + "\n" + textarea.textContent
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true }))
      }
      closePanel()
      return
    }
  }

  try {
    await navigator.clipboard.writeText(context)
    const { countEl } = ensurePanel()
    const prev = countEl.textContent
    countEl.textContent = "Copied ✓"
    setTimeout(() => { countEl.textContent = prev }, 1800)
  } catch {}
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
    payload: { url: data.url, title: data.title, text: data.text, timestamp: data.timestamp, time_spent: 30_000 }
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
  if (isOnTwitterBookmarks()) setupTwitterBookmarkCapture()
  else teardownTwitterBookmarkCapture()
}

// ── Init ──────────────────────────────────────────────────────────────────────

wrapHistoryMethod("pushState")
wrapHistoryMethod("replaceState")

window.addEventListener("load", () => { schedulePageSnapshot(); handleUrlChange() })
window.addEventListener("popstate", () => { schedulePageSnapshot(); handleUrlChange() })
window.addEventListener("hashchange", () => { schedulePageSnapshot(); handleUrlChange() })

const titleObserver = new MutationObserver(() => schedulePageSnapshot())
if (document.head) {
  titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true })
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === TOGGLE_SEARCH_PANEL_MESSAGE) handleOpenPanel("context")
  if (message?.type === OPEN_PANEL_MESSAGE) handleOpenPanel(message.mode || "context")
})

schedulePageSnapshot()
