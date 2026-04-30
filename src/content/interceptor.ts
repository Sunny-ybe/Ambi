import type { MessageToBackground, MessageFromBackground } from "../shared/types";
import { hostnameFromUrl } from "../shared/sanitize";
import { showBanner } from "./banner";

// ── Site-specific textarea selectors ──────────────────────────────────────────

interface SiteConfig {
  textareaSelector: string;
  submitSelector: string;
}

const SITE_CONFIGS: Record<string, SiteConfig> = {
  "chat.openai.com": {
    textareaSelector: "#prompt-textarea",
    submitSelector: 'button[data-testid="send-button"]',
  },
  "chatgpt.com": {
    textareaSelector: "#prompt-textarea",
    submitSelector: 'button[data-testid="send-button"]',
  },
  "claude.ai": {
    textareaSelector: 'div[contenteditable="true"].ProseMirror',
    submitSelector: 'button[aria-label="Send message"]',
  },
  "chat.deepseek.com": {
    textareaSelector: "textarea#chat-input",
    submitSelector: 'button[aria-label="Send"]',
  },
  "gemini.google.com": {
    textareaSelector: "rich-textarea .ql-editor",
    submitSelector: 'button.send-button',
  },
};

// ── Message helpers ────────────────────────────────────────────────────────────

function sendMessage(msg: MessageToBackground): Promise<MessageFromBackground> {
  return chrome.runtime.sendMessage(msg) as Promise<MessageFromBackground>;
}

// ── Intercept logic ────────────────────────────────────────────────────────────

function getPromptText(el: Element): string {
  if (el instanceof HTMLTextAreaElement) return el.value;
  // contenteditable
  return (el as HTMLElement).innerText ?? "";
}

function setPromptText(el: Element, text: string): void {
  if (el instanceof HTMLTextAreaElement) {
    // Use nativeInputValueSetter to work with React-controlled inputs
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    nativeSetter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    // contenteditable: set as plain text only
    (el as HTMLElement).innerText = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

async function interceptSend(
  textarea: Element,
  site: string
): Promise<void> {
  const promptText = getPromptText(textarea).trim();
  if (!promptText) return;

  const response = await sendMessage({
    type: "GET_CONTEXT",
    prompt: promptText,
    site,
  });

  if (response.type !== "CONTEXT_RESPONSE") return;
  const { context, tokenCount } = response;

  if (context.length > 0) {
    const injected = `${context}\n\n${promptText}`;
    setPromptText(textarea, injected);
    showBanner(tokenCount, context);
  }

  // Log the original (non-injected) question
  await sendMessage({ type: "LOG_QUESTION", text: promptText.slice(0, 200), site });
}

// ── Init ───────────────────────────────────────────────────────────────────────

export function initInterceptor(): void {
  const site = hostnameFromUrl(window.location.href);
  const config = SITE_CONFIGS[site];
  if (!config) return;

  // Use a MutationObserver to wait for the textarea to appear (SPAs)
  const observer = new MutationObserver(() => {
    const textarea = document.querySelector(config.textareaSelector);
    if (!textarea) return;

    observer.disconnect();
    attachListeners(textarea, config, site);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Also try immediately
  const textarea = document.querySelector(config.textareaSelector);
  if (textarea) {
    observer.disconnect();
    attachListeners(textarea, config, site);
  }
}

function attachListeners(textarea: Element, config: SiteConfig, site: string): void {
  let intercepted = false;

  // Intercept Enter key on the textarea
  textarea.addEventListener(
    "keydown",
    async (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" && !ke.shiftKey && !intercepted) {
        intercepted = true;
        ke.stopImmediatePropagation();
        ke.preventDefault();
        await interceptSend(textarea, site);
        intercepted = false;
        // Re-trigger submit after injection
        const submitBtn = document.querySelector(config.submitSelector);
        (submitBtn as HTMLElement | null)?.click();
      }
    },
    true // capture phase so we beat site's own handlers
  );

  // Intercept submit button click
  document.addEventListener(
    "click",
    async (e) => {
      const target = e.target as Element | null;
      if (!target) return;
      const submitBtn = document.querySelector(config.submitSelector);
      if (submitBtn && (target === submitBtn || submitBtn.contains(target)) && !intercepted) {
        intercepted = true;
        e.stopImmediatePropagation();
        e.preventDefault();
        await interceptSend(textarea, site);
        intercepted = false;
        (submitBtn as HTMLElement).click();
      }
    },
    true
  );
}
