import { useEffect, useState } from "react";
import type {
  AmbiSettings,
  IdentityModel,
  MessageFromBackground,
} from "../shared/types";

function sendMessage(msg: object): Promise<MessageFromBackground> {
  return chrome.runtime.sendMessage(msg) as Promise<MessageFromBackground>;
}

const BUDGET_OPTIONS: Array<1000 | 1500 | 2000> = [1000, 1500, 2000];

const ALL_SITES = [
  "chat.openai.com",
  "chatgpt.com",
  "claude.ai",
  "chat.deepseek.com",
  "gemini.google.com",
];

export default function Popup() {
  const [settings, setSettings] = useState<AmbiSettings | null>(null);
  const [model, setModel] = useState<IdentityModel | null>(null);
  const [tab, setTab] = useState<"settings" | "model">("settings");
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    Promise.all([
      sendMessage({ type: "GET_SETTINGS" }),
      sendMessage({ type: "GET_MODEL" }),
    ]).then(([sRes, mRes]) => {
      if (sRes.type === "SETTINGS_RESPONSE") setSettings(sRes.settings);
      if (mRes.type === "MODEL_RESPONSE") setModel(mRes.model);
    });
  }, []);

  async function updateSetting<K extends keyof AmbiSettings>(
    key: K,
    value: AmbiSettings[K]
  ) {
    if (!settings) return;
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    await sendMessage({ type: "UPDATE_SETTINGS", settings: { [key]: value } });
  }

  async function toggleSite(site: string) {
    if (!settings) return;
    const enabled = settings.enabledSites.includes(site)
      ? settings.enabledSites.filter((s) => s !== site)
      : [...settings.enabledSites, site];
    await updateSetting("enabledSites", enabled);
  }

  async function clearData() {
    if (!confirm("Clear all Ambi data? This cannot be undone.")) return;
    await sendMessage({ type: "CLEAR_ALL_DATA" });
    setModel({ activeProjects: [], recurringTopics: [], recentQuestions: [], openThreads: [] });
    setCleared(true);
  }

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <span style={styles.logo}>Ambi</span>
        <div style={styles.tabRow}>
          <button
            style={{ ...styles.tab, ...(tab === "settings" ? styles.tabActive : {}) }}
            onClick={() => setTab("settings")}
          >
            Settings
          </button>
          <button
            style={{ ...styles.tab, ...(tab === "model" ? styles.tabActive : {}) }}
            onClick={() => setTab("model")}
          >
            My model
          </button>
        </div>
      </header>

      {tab === "settings" && settings && (
        <main style={styles.main}>
          {/* Master toggle */}
          <Row label="Injection enabled">
            <Toggle
              on={settings.injectionEnabled}
              onChange={(v) => void updateSetting("injectionEnabled", v)}
            />
          </Row>

          {/* Token budget */}
          <section style={styles.section}>
            <label style={styles.label}>Token budget</label>
            <div style={styles.pillRow}>
              {BUDGET_OPTIONS.map((b) => (
                <button
                  key={b}
                  style={{
                    ...styles.pill,
                    ...(settings.tokenBudget === b ? styles.pillActive : {}),
                  }}
                  onClick={() => void updateSetting("tokenBudget", b)}
                >
                  {b.toLocaleString()}
                </button>
              ))}
            </div>
          </section>

          {/* Per-site toggles */}
          <section style={styles.section}>
            <label style={styles.label}>Active sites</label>
            {ALL_SITES.map((site) => (
              <Row key={site} label={site}>
                <Toggle
                  on={settings.enabledSites.includes(site)}
                  onChange={() => void toggleSite(site)}
                />
              </Row>
            ))}
          </section>

          {/* Clear data */}
          <section style={{ ...styles.section, marginTop: "auto" }}>
            <button style={styles.dangerBtn} onClick={() => void clearData()}>
              {cleared ? "Cleared" : "Clear all data"}
            </button>
          </section>
        </main>
      )}

      {tab === "model" && model && (
        <main style={styles.main}>
          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Active projects</h2>
            {model.activeProjects.length === 0 ? (
              <p style={styles.muted}>None yet — browse a bit first.</p>
            ) : (
              model.activeProjects.map((p, i) => (
                <div key={i} style={styles.card}>
                  <strong style={styles.cardLabel}>{p.label}</strong>
                  <span style={styles.cardMeta}>{p.keywords.slice(0, 6).join(", ")}</span>
                </div>
              ))
            )}
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Recurring topics</h2>
            {model.recurringTopics.length === 0 ? (
              <p style={styles.muted}>None yet.</p>
            ) : (
              <div style={styles.tagCloud}>
                {model.recurringTopics.map((t, i) => (
                  <span key={i} style={styles.tag}>
                    {t.label} <span style={styles.tagCount}>×{t.hits}</span>
                  </span>
                ))}
              </div>
            )}
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Open threads</h2>
            {model.openThreads.length === 0 ? (
              <p style={styles.muted}>None — add them in the side panel.</p>
            ) : (
              model.openThreads.map((t, i) => (
                <div key={i} style={styles.card}>
                  <span style={styles.cardLabel}>{t.text}</span>
                </div>
              ))
            )}
          </section>
        </main>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.row}>
      <span style={styles.rowLabel}>{label}</span>
      {children}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      style={{
        ...styles.toggle,
        background: on ? "#6c63ff" : "#2a2a4a",
      }}
      onClick={() => onChange(!on)}
      aria-pressed={on}
    >
      <div
        style={{
          ...styles.toggleThumb,
          transform: on ? "translateX(16px)" : "translateX(0)",
        }}
      />
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    width: "320px",
    fontFamily: "system-ui, sans-serif",
    background: "#0f0f1a",
    color: "#e0e0ff",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    padding: "14px 16px 10px",
    borderBottom: "1px solid #2a2a4a",
  },
  logo: {
    fontSize: "16px",
    fontWeight: "700",
    color: "#6c63ff",
    display: "block",
    marginBottom: "10px",
  },
  tabRow: {
    display: "flex",
    gap: "8px",
  },
  tab: {
    background: "transparent",
    border: "1px solid #2a2a4a",
    color: "#888",
    borderRadius: "6px",
    padding: "3px 10px",
    cursor: "pointer",
    fontSize: "12px",
  },
  tabActive: {
    borderColor: "#6c63ff",
    color: "#e0e0ff",
    background: "#1a1a3a",
  },
  main: {
    padding: "14px 16px",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    maxHeight: "480px",
    overflowY: "auto",
  },
  section: {
    marginBottom: "16px",
  },
  sectionTitle: {
    fontSize: "11px",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "#6c63ff",
    margin: "0 0 8px",
  },
  label: {
    fontSize: "12px",
    color: "#888",
    display: "block",
    marginBottom: "6px",
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "6px 0",
    borderBottom: "1px solid #1a1a2e",
  },
  rowLabel: {
    fontSize: "13px",
    color: "#c0c0e0",
  },
  pillRow: {
    display: "flex",
    gap: "8px",
  },
  pill: {
    background: "#1a1a2e",
    border: "1px solid #2a2a4a",
    borderRadius: "16px",
    color: "#888",
    padding: "4px 14px",
    cursor: "pointer",
    fontSize: "12px",
  },
  pillActive: {
    borderColor: "#6c63ff",
    color: "#e0e0ff",
    background: "#2a2a5a",
  },
  toggle: {
    width: "36px",
    height: "20px",
    borderRadius: "10px",
    border: "none",
    cursor: "pointer",
    position: "relative",
    transition: "background 0.2s",
    padding: 0,
  },
  toggleThumb: {
    position: "absolute",
    top: "3px",
    left: "3px",
    width: "14px",
    height: "14px",
    borderRadius: "50%",
    background: "#fff",
    transition: "transform 0.2s",
  },
  dangerBtn: {
    background: "transparent",
    border: "1px solid #c0392b",
    color: "#c0392b",
    borderRadius: "6px",
    padding: "6px 14px",
    cursor: "pointer",
    fontSize: "13px",
    width: "100%",
  },
  card: {
    background: "#1a1a2e",
    borderRadius: "6px",
    padding: "8px 10px",
    marginBottom: "6px",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  cardLabel: {
    fontSize: "13px",
    color: "#d0d0f0",
    fontWeight: "600",
  },
  cardMeta: {
    fontSize: "11px",
    color: "#666",
  },
  muted: {
    fontSize: "12px",
    color: "#555",
    margin: 0,
  },
  tagCloud: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
  },
  tag: {
    background: "#1a1a3a",
    border: "1px solid #2a2a5a",
    borderRadius: "12px",
    padding: "2px 10px",
    fontSize: "12px",
    color: "#a0a0d0",
  },
  tagCount: {
    color: "#6c63ff",
    marginLeft: "4px",
  },
};
