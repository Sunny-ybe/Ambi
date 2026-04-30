// ── Identity Model ─────────────────────────────────────────────────────────────

export interface ActiveProject {
  label: string;
  keywords: string[];
  weight: number;       // recency-biased hit score
  lastSeen: number;     // unix ms
}

export interface RecurringTopic {
  label: string;
  keywords: string[];
  hits: number;
  lastSeen: number;
}

export interface RecentQuestion {
  text: string;         // first 200 chars only
  ts: number;
}

export interface OpenThread {
  text: string;
  ts: number;
}

export interface IdentityModel {
  activeProjects: ActiveProject[];      // max 5
  recurringTopics: RecurringTopic[];    // max 10
  recentQuestions: RecentQuestion[];    // max 20
  openThreads: OpenThread[];            // max 5 — user-added only
}

// ── Session Log ────────────────────────────────────────────────────────────────

export interface TabVisit {
  url: string;          // sanitized (no query/fragment)
  title: string;
  dwellMs: number;
  ts: number;
}

export interface QuestionEntry {
  text: string;         // first 200 chars
  site: string;         // e.g. "claude.ai"
  ts: number;
}

export interface SessionLog {
  id: string;           // date string YYYY-MM-DD
  startTs: number;
  tabVisits: TabVisit[];
  questions: QuestionEntry[];
}

// ── Storage Root ───────────────────────────────────────────────────────────────

export interface AmbiStorage {
  model: IdentityModel;
  currentSession: SessionLog;
  previousSession: SessionLog | null;
  settings: AmbiSettings;
  onboardingComplete: boolean;
}

export interface AmbiSettings {
  tokenBudget: 1000 | 1500 | 2000;
  injectionEnabled: boolean;
  enabledSites: string[];   // hostnames where injection is active
}

// ── Message Protocol ───────────────────────────────────────────────────────────

export type MessageToBackground =
  | { type: "GET_CONTEXT"; prompt: string; site: string }
  | { type: "LOG_QUESTION"; text: string; site: string }
  | { type: "LOG_TAB_VISIT"; visit: TabVisit }
  | { type: "ADD_OPEN_THREAD"; text: string }
  | { type: "GET_SESSION_SUMMARY" }
  | { type: "GET_SETTINGS" }
  | { type: "UPDATE_SETTINGS"; settings: Partial<AmbiSettings> }
  | { type: "GET_MODEL" }
  | { type: "CLEAR_ALL_DATA" };

export type MessageFromBackground =
  | { type: "CONTEXT_RESPONSE"; context: string; tokenCount: number }
  | { type: "SESSION_SUMMARY"; current: SessionLog; previous: SessionLog | null }
  | { type: "SETTINGS_RESPONSE"; settings: AmbiSettings }
  | { type: "MODEL_RESPONSE"; model: IdentityModel }
  | { type: "ACK" };
