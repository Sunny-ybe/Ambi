import type {
  MessageToBackground,
  MessageFromBackground,
  AmbiSettings,
} from "../shared/types";
import {
  getStorage,
  saveModel,
  saveSession,
  rotateSessions,
  saveSettings,
  clearAllData,
} from "./storage";
import { startTabObserver } from "./tabObserver";
import { ingestTabVisit, ingestQuestion, addOpenThread } from "./model";
import { buildContext } from "./contextBuilder";
import { truncateQuestion } from "../shared/sanitize";
import { estimateTokens } from "../shared/tokenizer";

// ── Session rotation ───────────────────────────────────────────────────────────

async function maybeRotateSession(): Promise<void> {
  const store = await getStorage();
  const todayId = new Date().toISOString().slice(0, 10);
  if (store.currentSession.id !== todayId) {
    await rotateSessions(store.currentSession);
  }
}

// ── Tab observer ───────────────────────────────────────────────────────────────

startTabObserver(async (visit) => {
  const store = await getStorage();
  const updatedModel = ingestTabVisit(store.model, visit);
  const updatedSession = {
    ...store.currentSession,
    tabVisits: [...store.currentSession.tabVisits, visit],
  };
  await Promise.all([saveModel(updatedModel), saveSession(updatedSession)]);
});

// ── Hotkey → open side panel ───────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "open-sidepanel") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null && tab.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  }
});

// ── Message router ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    rawMsg: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: MessageFromBackground) => void
  ) => {
    // Security: only accept messages from this extension
    if (sender.id !== chrome.runtime.id) return false;

    const msg = rawMsg as MessageToBackground;
    handle(msg).then(sendResponse).catch(console.error);
    return true; // keep channel open for async
  }
);

async function handle(msg: MessageToBackground): Promise<MessageFromBackground> {
  await maybeRotateSession();
  const store = await getStorage();

  switch (msg.type) {
    case "GET_CONTEXT": {
      if (!store.settings.injectionEnabled) {
        return { type: "CONTEXT_RESPONSE", context: "", tokenCount: 0 };
      }
      if (!store.settings.enabledSites.includes(msg.site)) {
        return { type: "CONTEXT_RESPONSE", context: "", tokenCount: 0 };
      }
      const context = buildContext(store.model, msg.prompt, store.settings.tokenBudget);
      return {
        type: "CONTEXT_RESPONSE",
        context,
        tokenCount: estimateTokens(context),
      };
    }

    case "LOG_QUESTION": {
      const text = truncateQuestion(msg.text);
      const updatedModel = ingestQuestion(store.model, text);
      const updatedSession = {
        ...store.currentSession,
        questions: [
          ...store.currentSession.questions,
          { text, site: msg.site, ts: Date.now() },
        ],
      };
      await Promise.all([saveModel(updatedModel), saveSession(updatedSession)]);
      return { type: "ACK" };
    }

    case "LOG_TAB_VISIT": {
      const updatedModel = ingestTabVisit(store.model, msg.visit);
      const updatedSession = {
        ...store.currentSession,
        tabVisits: [...store.currentSession.tabVisits, msg.visit],
      };
      await Promise.all([saveModel(updatedModel), saveSession(updatedSession)]);
      return { type: "ACK" };
    }

    case "ADD_OPEN_THREAD": {
      const updatedModel = addOpenThread(store.model, msg.text);
      await saveModel(updatedModel);
      return { type: "ACK" };
    }

    case "GET_SESSION_SUMMARY": {
      return {
        type: "SESSION_SUMMARY",
        current: store.currentSession,
        previous: store.previousSession,
      };
    }

    case "GET_SETTINGS": {
      return { type: "SETTINGS_RESPONSE", settings: store.settings };
    }

    case "UPDATE_SETTINGS": {
      const updated: AmbiSettings = { ...store.settings, ...msg.settings };
      await saveSettings(updated);
      return { type: "ACK" };
    }

    case "GET_MODEL": {
      return { type: "MODEL_RESPONSE", model: store.model };
    }

    case "CLEAR_ALL_DATA": {
      await clearAllData();
      return { type: "ACK" };
    }
  }
}

// ── Install / uninstall hooks ──────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/sidepanel/index.html") });
  }
});

// Register uninstall URL so we can clear data if needed in future
chrome.runtime.setUninstallURL("https://ambi.app/uninstall");
