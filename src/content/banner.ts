/**
 * Renders an injection notification banner in an isolated Shadow DOM.
 * The host page JS cannot read or manipulate this element.
 */

const BANNER_HOST_ID = "ambi-banner-host";

export function showBanner(tokenCount: number, contextText: string): void {
  removeBanner();

  const host = document.createElement("div");
  host.id = BANNER_HOST_ID;

  // Inline style on the host — minimal footprint
  Object.assign(host.style, {
    position: "fixed",
    bottom: "16px",
    right: "16px",
    zIndex: "2147483647",
    fontFamily: "system-ui, sans-serif",
  });

  const shadow = host.attachShadow({ mode: "closed" });

  const container = document.createElement("div");
  Object.assign(container.style, {
    background: "#1a1a2e",
    color: "#e0e0ff",
    borderRadius: "8px",
    padding: "10px 14px",
    fontSize: "13px",
    lineHeight: "1.5",
    maxWidth: "320px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  });

  const top = document.createElement("div");
  Object.assign(top.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  });

  const label = document.createElement("span");
  label.textContent = `Ambi injected ${tokenCount} tokens of context`;
  Object.assign(label.style, { fontWeight: "600" });

  const actions = document.createElement("div");
  Object.assign(actions.style, { display: "flex", gap: "8px" });

  const viewBtn = createButton("View", "#6c63ff");
  const dismissBtn = createButton("✕", "transparent", "#888");

  let expanded = false;
  const preview = document.createElement("pre");
  Object.assign(preview.style, {
    margin: "0",
    padding: "8px",
    background: "#0d0d1a",
    borderRadius: "4px",
    fontSize: "11px",
    color: "#aaa",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    maxHeight: "160px",
    overflowY: "auto",
    display: "none",
  });
  // textContent is safe — never innerHTML
  preview.textContent = contextText;

  viewBtn.addEventListener("click", () => {
    expanded = !expanded;
    preview.style.display = expanded ? "block" : "none";
    viewBtn.textContent = expanded ? "Hide" : "View";
  });

  dismissBtn.addEventListener("click", () => removeBanner());

  actions.appendChild(viewBtn);
  actions.appendChild(dismissBtn);
  top.appendChild(label);
  top.appendChild(actions);
  container.appendChild(top);
  container.appendChild(preview);
  shadow.appendChild(container);
  document.body.appendChild(host);

  // Auto-dismiss after 8 seconds
  setTimeout(() => removeBanner(), 8_000);
}

export function removeBanner(): void {
  document.getElementById(BANNER_HOST_ID)?.remove();
}

function createButton(
  text: string,
  bg: string,
  color = "#fff"
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = text;
  Object.assign(btn.style, {
    background: bg,
    color,
    border: "none",
    borderRadius: "4px",
    padding: "2px 8px",
    cursor: "pointer",
    fontSize: "12px",
  });
  return btn;
}
