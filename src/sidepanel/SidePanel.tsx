import { useEffect, useState } from "react";
import type { SessionLog, MessageFromBackground } from "../shared/types";

function sendMessage(msg: object): Promise<MessageFromBackground> {
  return chrome.runtime.sendMessage(msg) as Promise<MessageFromBackground>;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDwell(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export default function SidePanel() {
  const [current, setCurrent] = useState<SessionLog | null>(null);
  const [previous, setPrevious] = useState<SessionLog | null>(null);
  const [view, setView] = useState<"current" | "previous">("current");
  const [threadInput, setThreadInput] = useState("");

  useEffect(() => {
    sendMessage({ type: "GET_SESSION_SUMMARY" }).then((res) => {
      if (res.type === "SESSION_SUMMARY") {
        setCurrent(res.current);
        setPrevious(res.previous);
      }
    });
  }, []);

  const session = view === "current" ? current : previous;

  async function addThread() {
    if (!threadInput.trim()) return;
    await sendMessage({ type: "ADD_OPEN_THREAD", text: threadInput.trim() });
    setThreadInput("");
  }

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <span style={styles.logo}>Ambi</span>
        <div style={styles.tabRow}>
          <button
            style={{ ...styles.tab, ...(view === "current" ? styles.tabActive : {}) }}
            onClick={() => setView("current")}
          >
            Today
          </button>
          <button
            style={{ ...styles.tab, ...(view === "previous" ? styles.tabActive : {}) }}
            onClick={() => setView("previous")}
            disabled={previous === null}
          >
            Last session
          </button>
        </div>
      </header>

      {session === null ? (
        <div style={styles.empty}>No session data yet.</div>
      ) : (
        <main style={styles.main}>
          {/* Questions asked */}
          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Questions asked</h2>
            {session.questions.length === 0 ? (
              <p style={styles.muted}>None yet.</p>
            ) : (
              <ul style={styles.list}>
                {session.questions.map((q, i) => (
                  <li key={i} style={styles.listItem}>
                    <span style={styles.itemText}>"{q.text}"</span>
                    <span style={styles.meta}>{q.site} · {formatTime(q.ts)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Tabs visited */}
          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Tabs visited</h2>
            {session.tabVisits.length === 0 ? (
              <p style={styles.muted}>None yet.</p>
            ) : (
              <ul style={styles.list}>
                {session.tabVisits.slice(-10).reverse().map((v, i) => (
                  <li key={i} style={styles.listItem}>
                    <span style={styles.itemText}>{v.title}</span>
                    <span style={styles.meta}>{formatDwell(v.dwellMs)} · {formatTime(v.ts)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Open threads (only on current) */}
          {view === "current" && (
            <section style={styles.section}>
              <h2 style={styles.sectionTitle}>Open threads</h2>
              <div style={styles.threadRow}>
                <input
                  style={styles.input}
                  placeholder="Add an open question..."
                  value={threadInput}
                  onChange={(e) => setThreadInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void addThread(); }}
                  maxLength={200}
                />
                <button style={styles.addBtn} onClick={() => void addThread()}>Add</button>
              </div>
            </section>
          )}
        </main>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    fontFamily: "system-ui, sans-serif",
    background: "#0f0f1a",
    color: "#e0e0ff",
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    padding: "16px",
    borderBottom: "1px solid #2a2a4a",
  },
  logo: {
    fontSize: "18px",
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
    padding: "4px 12px",
    cursor: "pointer",
    fontSize: "13px",
  },
  tabActive: {
    borderColor: "#6c63ff",
    color: "#e0e0ff",
    background: "#1a1a3a",
  },
  main: {
    flex: 1,
    overflowY: "auto",
    padding: "16px",
  },
  section: {
    marginBottom: "24px",
  },
  sectionTitle: {
    fontSize: "12px",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "#6c63ff",
    margin: "0 0 10px",
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  listItem: {
    background: "#1a1a2e",
    borderRadius: "6px",
    padding: "8px 10px",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  itemText: {
    fontSize: "13px",
    color: "#d0d0f0",
  },
  meta: {
    fontSize: "11px",
    color: "#666",
  },
  muted: {
    fontSize: "13px",
    color: "#555",
    margin: 0,
  },
  empty: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#555",
    fontSize: "14px",
  },
  threadRow: {
    display: "flex",
    gap: "8px",
  },
  input: {
    flex: 1,
    background: "#1a1a2e",
    border: "1px solid #2a2a4a",
    borderRadius: "6px",
    padding: "6px 10px",
    color: "#e0e0ff",
    fontSize: "13px",
    outline: "none",
  },
  addBtn: {
    background: "#6c63ff",
    border: "none",
    borderRadius: "6px",
    color: "#fff",
    padding: "6px 14px",
    cursor: "pointer",
    fontSize: "13px",
  },
};
