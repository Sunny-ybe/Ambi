const PAGE_METADATA_MESSAGE = "PAGE_METADATA"
const SEARCH_QUERY_MESSAGE = "SEARCH_QUERY"
const OPEN_SEARCH_RESULT_MESSAGE = "OPEN_SEARCH_RESULT"
const TOGGLE_SEARCH_PANEL_MESSAGE = "TOGGLE_SEARCH_PANEL"
const INGEST_ITEM_MESSAGE = "INGEST_ITEM"
const DELETE_ITEM_MESSAGE = "DELETE_ITEM"
const OPEN_PANEL_MESSAGE = "OPEN_PANEL"

const LINK_CATEGORIES = {
  AI:            ["claude.ai", "chat.openai.com", "gemini.google", "perplexity.ai", "cursor.sh", "v0.dev", "huggingface.co"],
  Dev:           ["github.com", "stackoverflow.com", "codepen.io", "replit.com", "vercel.com", "netlify.com", "npmjs.com", "developer.mozilla"],
  Education:     ["canvas", "blackboard", "moodle", "coursera.com", "udemy.com", ".edu", "khanacademy.org", "leetcode.com"],
  Social:        ["instagram.com", "twitter.com", "x.com", "facebook.com", "reddit.com", "threads.net"],
  Productivity:  ["notion.so", "docs.google.com", "drive.google.com", "figma.com", "linear.app", "mail.google.com", "airtable.com", "trello.com"],
  Entertainment: ["youtube.com", "netflix.com", "spotify.com", "twitch.tv"],
  News:          ["news.ycombinator.com", "techcrunch.com", "medium.com", "substack.com"],
}

function cleanLinkUrl(url) {
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname}`.replace(/\/$/, "")
  } catch { return url }
}

function categorizeLinkUrl(url) {
  try {
    const hostname = new URL(url).hostname
    for (const [category, patterns] of Object.entries(LINK_CATEGORIES)) {
      if (patterns.some(p => hostname.includes(p) || url.includes(p))) return category
    }
  } catch {}
  return "Other"
}

function shouldSkipLinkUrl(url) {
  if (!url) return true
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:") ||
    url.includes("newtab") ||
    url.startsWith("data:") ||
    url.includes("localhost") ||
    url.includes("127.0.0.1")
  )
}

async function recordLink(url, title, favIconUrl) {
  if (shouldSkipLinkUrl(url)) return
  const category = categorizeLinkUrl(url)
  const key = cleanLinkUrl(url)
  let favicon
  try {
    favicon = favIconUrl || `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`
  } catch { favicon = "" }

  const stored = await chrome.storage.local.get("links")
  const links = stored.links || {}

  for (const [cat, items] of Object.entries(links)) {
    const idx = items.findIndex(l => cleanLinkUrl(l.url) === key)
    if (idx !== -1) {
      const updated = {
        ...items[idx],
        title: title || items[idx].title,
        favicon: favIconUrl || items[idx].favicon,
        visits: (items[idx].visits || 0) + 1,
        lastVisited: Date.now()
      }
      if (cat === category) {
        links[cat][idx] = updated
      } else {
        links[cat].splice(idx, 1)
        if (!links[category]) links[category] = []
        links[category].push(updated)
      }
      await chrome.storage.local.set({ links })
      return
    }
  }

  if (!links[category]) links[category] = []
  links[category].push({ url, title: title || key, favicon, visits: 1, lastVisited: Date.now() })
  await chrome.storage.local.set({ links })
}

async function seedFromHistory() {
  const startTime = Date.now() - 30 * 24 * 60 * 60 * 1000
  try {
    const items = await chrome.history.search({ text: "", startTime, maxResults: 2000 })
    const stored = await chrome.storage.local.get("links")
    const links = stored.links || {}

    const existingKeys = new Set(
      Object.values(links).flat().map(l => cleanLinkUrl(l.url))
    )

    for (const item of items) {
      if (shouldSkipLinkUrl(item.url)) continue
      const key = cleanLinkUrl(item.url)
      if (existingKeys.has(key)) continue
      const category = categorizeLinkUrl(item.url)
      let favicon
      try { favicon = `https://www.google.com/s2/favicons?domain=${new URL(item.url).hostname}&sz=32` } catch { continue }
      if (!links[category]) links[category] = []
      links[category].push({
        url: item.url,
        title: item.title || key,
        favicon,
        visits: item.visitCount || 1,
        lastVisited: item.lastVisitTime || Date.now()
      })
      existingKeys.add(key)
    }

    await chrome.storage.local.set({ links })
  } catch (e) {
    console.error("History seeding failed:", e)
  }
}

async function openPanelInTab(mode) {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (!activeTab?.id || !isInjectableUrl(activeTab.url)) return
    try {
      await chrome.tabs.sendMessage(activeTab.id, { type: OPEN_PANEL_MESSAGE, mode })
    } catch (error) {
      if (error?.message?.includes("Receiving end does not exist")) {
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          files: ["Readability.js", "content.js"]
        })
        await chrome.tabs.sendMessage(activeTab.id, { type: OPEN_PANEL_MESSAGE, mode })
      } else {
        throw error
      }
    }
  } catch (error) {
    console.error("Unable to open Ambi panel:", error)
  }
}
const MINIMUM_DWELL_TIME_MS = 10_000
const STATE_DEBOUNCE_MS = 200
const INGEST_API_URL = "http://127.0.0.1:8000/ingest"
const SEARCH_API_URL = "http://127.0.0.1:8000/search"
const DELETE_API_URL = "http://127.0.0.1:8000/delete-by-url"

const STORAGE_KEYS = {
  ACTIVE_SESSION: "dwellActiveSession",
  FOCUSED_WINDOW_ID: "dwellFocusedWindowId",
  LAST_PROCESSED_STATE: "dwellLastProcessedState",
  PAGE_DATA_BY_TAB: "dwellPageDataByTab"
}

let operationQueue = Promise.resolve()

function enqueueOperation(operation) {
  const queuedOperation = operationQueue.then(operation, operation)
  operationQueue = queuedOperation.catch(() => {})
  return queuedOperation
}

async function getActiveSession() {
  const storedState = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_SESSION)
  return storedState[STORAGE_KEYS.ACTIVE_SESSION] || null
}

async function setActiveSession(session) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.ACTIVE_SESSION]: session
  })
}

async function clearActiveSession() {
  await chrome.storage.local.remove(STORAGE_KEYS.ACTIVE_SESSION)
}

async function setFocusedWindowId(windowId) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.FOCUSED_WINDOW_ID]: windowId
  })
}

async function getFocusedWindowId() {
  const storedState = await chrome.storage.local.get(STORAGE_KEYS.FOCUSED_WINDOW_ID)

  if (typeof storedState[STORAGE_KEYS.FOCUSED_WINDOW_ID] === "number") {
    return storedState[STORAGE_KEYS.FOCUSED_WINDOW_ID]
  }

  const focusedWindowId = await queryFocusedWindowId()
  await setFocusedWindowId(focusedWindowId)
  return focusedWindowId
}

async function queryFocusedWindowId() {
  try {
    const lastFocusedWindow = await chrome.windows.getLastFocused()
    return lastFocusedWindow?.focused
      ? lastFocusedWindow.id
      : chrome.windows.WINDOW_ID_NONE
  } catch (error) {
    console.error("Unable to resolve the focused window:", error)
    return chrome.windows.WINDOW_ID_NONE
  }
}

function normalizePageData(payload = {}, tab = {}) {
  return {
    url: payload.url || tab.url || "",
    title: payload.title || tab.title || "",
    text: payload.text || ""
  }
}

async function getPageDataMap() {
  const storedState = await chrome.storage.local.get(STORAGE_KEYS.PAGE_DATA_BY_TAB)
  return storedState[STORAGE_KEYS.PAGE_DATA_BY_TAB] || {}
}

async function getStoredPageData(tabId) {
  const pageDataByTab = await getPageDataMap()
  return pageDataByTab[String(tabId)] || null
}

async function upsertPageData(tabId, pageData) {
  const pageDataByTab = await getPageDataMap()
  const tabKey = String(tabId)

  pageDataByTab[tabKey] = {
    ...(pageDataByTab[tabKey] || {}),
    ...pageData
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.PAGE_DATA_BY_TAB]: pageDataByTab
  })

  return pageDataByTab[tabKey]
}

async function removePageData(tabId) {
  const pageDataByTab = await getPageDataMap()
  const tabKey = String(tabId)

  if (!(tabKey in pageDataByTab)) {
    return
  }

  delete pageDataByTab[tabKey]

  await chrome.storage.local.set({
    [STORAGE_KEYS.PAGE_DATA_BY_TAB]: pageDataByTab
  })
}

async function getPageDataForTab(tabId) {
  const cachedPageData = await getStoredPageData(tabId)

  if (cachedPageData?.url || cachedPageData?.title || cachedPageData?.text) {
    return cachedPageData
  }

  try {
    const tab = await chrome.tabs.get(tabId)
    const normalizedPageData = normalizePageData({}, tab)
    return upsertPageData(tabId, normalizedPageData)
  } catch (error) {
    return {
      url: "",
      title: "",
      text: ""
    }
  }
}

async function postIngestEvent(pageData, totalTimeSpent) {
  const response = await fetch(INGEST_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url: pageData.url || "",
      title: pageData.title || "",
      text: pageData.text || "",
      timestamp: new Date().toISOString(),
      time_spent: totalTimeSpent
    })
  })

  if (!response.ok) {
    throw new Error(`Ingest request failed with status ${response.status}.`)
  }

  return response.json()
}

async function getDesiredActiveTab(focusedWindowId) {
  if (
    typeof focusedWindowId !== "number" ||
    focusedWindowId === chrome.windows.WINDOW_ID_NONE
  ) {
    return null
  }

  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      windowId: focusedWindowId
    })

    if (!activeTab?.id || activeTab.incognito) {
      return null
    }

    const pageData = await getPageDataForTab(activeTab.id)

    return {
      tabId: activeTab.id,
      url: pageData.url || activeTab.url || "",
      title: pageData.title || activeTab.title || ""
    }
  } catch (error) {
    console.error("Unable to resolve the active tab:", error)
    return null
  }
}

function buildStateSignature(focusedWindowId, activeTab) {
  if (!activeTab) {
    return `window:${focusedWindowId}:inactive`
  }

  return `window:${focusedWindowId}:tab:${activeTab.tabId}:url:${activeTab.url}`
}

async function shouldSkipStateProcessing(signature) {
  const storedState = await chrome.storage.local.get(STORAGE_KEYS.LAST_PROCESSED_STATE)
  const lastProcessedState = storedState[STORAGE_KEYS.LAST_PROCESSED_STATE]
  const now = Date.now()

  if (
    lastProcessedState?.signature === signature &&
    now - lastProcessedState.timestamp < STATE_DEBOUNCE_MS
  ) {
    return true
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.LAST_PROCESSED_STATE]: {
      signature,
      timestamp: now
    }
  })

  return false
}

async function ingestDwellEventIfNeeded(session, overridePageData) {
  const totalTimeSpent = Date.now() - session.startTime

  if (totalTimeSpent <= MINIMUM_DWELL_TIME_MS) {
    return
  }

  const pageData = overridePageData || await getPageDataForTab(session.activeTabId)
  const payload = {
    url: pageData?.url || session.url || "",
    title: pageData?.title || session.title || "",
    text: pageData?.text || "",
    timestamp: new Date().toISOString(),
    time_spent: totalTimeSpent
  }

  try {
    await postIngestEvent(payload, totalTimeSpent)
    console.log("Ingested dwell event:", {
      ...payload,
      total_time_spent: totalTimeSpent
    })
  } catch (error) {
    console.error("Failed to ingest dwell event:", error, payload)
  }
}

async function finalizeSessionIfNeeded(session, overridePageData) {
  if (!session?.activeTabId || !session?.startTime) {
    await clearActiveSession()
    return
  }

  await clearActiveSession()
  await ingestDwellEventIfNeeded(session, overridePageData)
}

async function startNewSession(activeTab, focusedWindowId) {
  if (!activeTab?.tabId || focusedWindowId === chrome.windows.WINDOW_ID_NONE) {
    return
  }

  await setActiveSession({
    activeTabId: activeTab.tabId,
    url: activeTab.url || "",
    title: activeTab.title || "",
    startTime: Date.now()
  })
}

async function reconcileActiveSession() {
  const focusedWindowId = await getFocusedWindowId()
  const desiredActiveTab = await getDesiredActiveTab(focusedWindowId)
  const signature = buildStateSignature(focusedWindowId, desiredActiveTab)

  if (await shouldSkipStateProcessing(signature)) {
    return
  }

  const currentSession = await getActiveSession()
  const isSameSession =
    currentSession &&
    desiredActiveTab &&
    currentSession.activeTabId === desiredActiveTab.tabId &&
    currentSession.url === desiredActiveTab.url

  if (currentSession && !isSameSession) {
    await finalizeSessionIfNeeded(currentSession)
  }

  if (!desiredActiveTab) {
    return
  }

  const latestSession = await getActiveSession()

  if (
    latestSession &&
    latestSession.activeTabId === desiredActiveTab.tabId &&
    latestSession.url === desiredActiveTab.url
  ) {
    if (
      desiredActiveTab.title &&
      desiredActiveTab.title !== latestSession.title
    ) {
      await setActiveSession({
        ...latestSession,
        title: desiredActiveTab.title
      })
    }

    return
  }

  await startNewSession(desiredActiveTab, focusedWindowId)
}

async function handlePageMetadata(message, sender) {
  if (!sender.tab?.id || sender.tab?.incognito) {
    return
  }

  const normalizedPageData = normalizePageData(message.payload, sender.tab)
  const previousPageData = await getStoredPageData(sender.tab.id)
  const currentSession = await getActiveSession()

  if (!currentSession || currentSession.activeTabId !== sender.tab.id) {
    await upsertPageData(sender.tab.id, normalizedPageData)
    return
  }

  if (currentSession.url !== normalizedPageData.url) {
    await finalizeSessionIfNeeded(currentSession, previousPageData)
    await upsertPageData(sender.tab.id, normalizedPageData)

    const focusedWindowId = await getFocusedWindowId()

    if (sender.tab.active && sender.tab.windowId === focusedWindowId) {
      await startNewSession(
        {
          tabId: sender.tab.id,
          url: normalizedPageData.url,
          title: normalizedPageData.title
        },
        focusedWindowId
      )
    }

    return
  }

  await upsertPageData(sender.tab.id, normalizedPageData)

  if (normalizedPageData.title && normalizedPageData.title !== currentSession.title) {
    await setActiveSession({
      ...currentSession,
      title: normalizedPageData.title
    })
  }
}

async function handleSearchQuery(query) {
  const response = await fetch(SEARCH_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query })
  })

  if (!response.ok) {
    throw new Error(`Search request failed with status ${response.status}.`)
  }

  return response.json()
}

function isInjectableUrl(url) {
  if (!url) return false
  return (
    !url.startsWith("chrome://") &&
    !url.startsWith("chrome-extension://") &&
    !url.startsWith("https://chrome.google.com/webstore") &&
    !url.startsWith("about:") &&
    !url.startsWith("data:")
  )
}

async function toggleSearchPanel() {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    })

    if (!activeTab?.id || !isInjectableUrl(activeTab.url)) {
      return
    }

    try {
      await chrome.tabs.sendMessage(activeTab.id, {
        type: TOGGLE_SEARCH_PANEL_MESSAGE
      })
    } catch (error) {
      if (error?.message?.includes("Receiving end does not exist")) {
        // Tab was open before extension loaded — inject scripts now and retry
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          files: ["Readability.js", "content.js"]
        })
        await chrome.tabs.sendMessage(activeTab.id, {
          type: TOGGLE_SEARCH_PANEL_MESSAGE
        })
      } else {
        throw error
      }
    }
  } catch (error) {
    console.error("Unable to toggle the Ambi search panel:", error)
  }
}

async function handleOpenSearchResult(url) {
  if (!url) {
    return
  }

  await chrome.tabs.create({ url })
}

async function handleTabActivated() {
  await reconcileActiveSession()
}

async function handleWindowFocusChanged(windowId) {
  await setFocusedWindowId(windowId)
  await reconcileActiveSession()
}

async function handleTabRemoved(tabId) {
  const currentSession = await getActiveSession()
  const cachedPageData = await getStoredPageData(tabId)

  if (currentSession?.activeTabId === tabId) {
    await finalizeSessionIfNeeded(currentSession, cachedPageData)
  }

  await removePageData(tabId)
}

async function initializeTracking() {
  const focusedWindowId = await queryFocusedWindowId()
  await setFocusedWindowId(focusedWindowId)
  await reconcileActiveSession()
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === PAGE_METADATA_MESSAGE) {
    void enqueueOperation(() => handlePageMetadata(message, sender))
    return
  }

  if (message?.type === SEARCH_QUERY_MESSAGE) {
    void handleSearchQuery(message.query)
      .then((payload) => {
        sendResponse({
          ok: true,
          payload
        })
      })
      .catch((error) => {
        console.error("Search failed:", error)
        sendResponse({
          ok: false,
          error: error.message
        })
      })

    return true
  }

  if (message?.type === OPEN_SEARCH_RESULT_MESSAGE) {
    void handleOpenSearchResult(message.url)
    return
  }

  if (message?.type === INGEST_ITEM_MESSAGE) {
    const p = message.payload || {}
    void postIngestEvent(p, p.time_spent || 30_000)
    return
  }

  if (message?.type === DELETE_ITEM_MESSAGE) {
    void fetch(DELETE_API_URL, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: message.url })
    })
      .then(async (res) => {
        sendResponse({ ok: res.ok, status: res.status })
      })
      .catch(() => {
        sendResponse({ ok: false })
      })
    return true
  }
})

chrome.tabs.onActivated.addListener(() => {
  void enqueueOperation(handleTabActivated)
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  void enqueueOperation(() => handleWindowFocusChanged(windowId))
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void enqueueOperation(() => handleTabRemoved(tabId))
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url || tab.incognito) return
  void recordLink(tab.url, tab.title, tab.favIconUrl)
})

chrome.commands.onCommand.addListener((command) => {
  if (command === "open-context") void openPanelInTab("context")
  if (command === "open-links") void openPanelInTab("links")
})

chrome.runtime.onStartup.addListener(() => {
  void enqueueOperation(initializeTracking)
})

chrome.runtime.onInstalled.addListener(() => {
  void enqueueOperation(initializeTracking)
  void seedFromHistory()
})

void enqueueOperation(initializeTracking)
