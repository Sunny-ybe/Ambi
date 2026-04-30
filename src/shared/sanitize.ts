/**
 * Strip query string and fragment from a URL.
 * Returns just scheme + host + pathname.
 * Returns empty string if the URL is unparseable.
 */
export function sanitizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "";
  }
}

/**
 * Extract the hostname from a URL for display / site identification.
 */
export function hostnameFromUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "";
  }
}

/**
 * Truncate a question string to at most 200 characters.
 */
export function truncateQuestion(text: string): string {
  return text.length <= 200 ? text : text.slice(0, 197) + "...";
}
