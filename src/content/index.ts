import { initInterceptor } from "./interceptor";

// Guard: never run on non-AI sites (belt-and-suspenders beyond manifest matches)
const ALLOWED_HOSTS = new Set([
  "chat.openai.com",
  "chatgpt.com",
  "claude.ai",
  "chat.deepseek.com",
  "gemini.google.com",
]);

if (ALLOWED_HOSTS.has(window.location.hostname)) {
  initInterceptor();
}
