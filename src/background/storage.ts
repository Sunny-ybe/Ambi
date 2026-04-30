import type { AmbiStorage, AmbiSettings, IdentityModel, SessionLog } from "../shared/types";

const DEFAULT_SETTINGS: AmbiSettings = {
  tokenBudget: 1000,
  injectionEnabled: true,
  enabledSites: [
    "chat.openai.com",
    "chatgpt.com",
    "claude.ai",
    "chat.deepseek.com",
    "gemini.google.com",
  ],
};

const DEFAULT_MODEL: IdentityModel = {
  activeProjects: [],
  recurringTopics: [],
  recentQuestions: [],
  openThreads: [],
};

function todayId(): string {
  return new Date().toISOString().slice(0, 10);
}

function newSession(): SessionLog {
  return {
    id: todayId(),
    startTs: Date.now(),
    tabVisits: [],
    questions: [],
  };
}

export async function getStorage(): Promise<AmbiStorage> {
  const result = await chrome.storage.local.get([
    "model",
    "currentSession",
    "previousSession",
    "settings",
    "onboardingComplete",
  ]);

  return {
    model: (result["model"] as IdentityModel | undefined) ?? DEFAULT_MODEL,
    currentSession: (result["currentSession"] as SessionLog | undefined) ?? newSession(),
    previousSession: (result["previousSession"] as SessionLog | null | undefined) ?? null,
    settings: (result["settings"] as AmbiSettings | undefined) ?? DEFAULT_SETTINGS,
    onboardingComplete: (result["onboardingComplete"] as boolean | undefined) ?? false,
  };
}

export async function saveModel(model: IdentityModel): Promise<void> {
  await chrome.storage.local.set({ model });
}

export async function saveSession(session: SessionLog): Promise<void> {
  await chrome.storage.local.set({ currentSession: session });
}

export async function rotateSessions(current: SessionLog): Promise<SessionLog> {
  await chrome.storage.local.set({
    previousSession: current,
    currentSession: newSession(),
  });
  return newSession();
}

export async function saveSettings(settings: AmbiSettings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

export async function markOnboardingComplete(): Promise<void> {
  await chrome.storage.local.set({ onboardingComplete: true });
}

export async function clearAllData(): Promise<void> {
  await chrome.storage.local.clear();
}
