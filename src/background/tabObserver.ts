import type { TabVisit } from "../shared/types";
import { sanitizeUrl, hostnameFromUrl } from "../shared/sanitize";

const MIN_DWELL_MS = 10_000; // ignore bounces under 10 seconds

interface PendingVisit {
  tabId: number;
  url: string;
  title: string;
  activatedAt: number;
}

let pending: PendingVisit | null = null;

type VisitCallback = (visit: TabVisit) => void;

export function startTabObserver(onVisit: VisitCallback): void {
  chrome.tabs.onActivated.addListener(async (info) => {
    const now = Date.now();

    // Close out the previous pending visit
    if (pending !== null) {
      const dwell = now - pending.activatedAt;
      if (dwell >= MIN_DWELL_MS) {
        onVisit({
          url: sanitizeUrl(pending.url),
          title: pending.title,
          dwellMs: dwell,
          ts: pending.activatedAt,
        });
      }
    }

    try {
      const tab = await chrome.tabs.get(info.tabId);
      if (tab.url && tab.url.startsWith("http")) {
        pending = {
          tabId: info.tabId,
          url: tab.url,
          title: tab.title ?? hostnameFromUrl(tab.url),
          activatedAt: now,
        };
      } else {
        pending = null;
      }
    } catch {
      pending = null;
    }
  });

  // Update title/url if the tab navigates while active
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (
      pending !== null &&
      pending.tabId === tabId &&
      changeInfo.status === "complete" &&
      tab.url &&
      tab.url.startsWith("http")
    ) {
      pending.url = tab.url;
      pending.title = tab.title ?? hostnameFromUrl(tab.url);
    }
  });

  // Flush on window focus loss
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE && pending !== null) {
      const dwell = Date.now() - pending.activatedAt;
      if (dwell >= MIN_DWELL_MS) {
        onVisit({
          url: sanitizeUrl(pending.url),
          title: pending.title,
          dwellMs: dwell,
          ts: pending.activatedAt,
        });
      }
      pending = null;
    }
  });
}
