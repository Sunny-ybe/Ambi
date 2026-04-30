// Approximation: 4 characters ≈ 1 token (GPT-family heuristic)
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncate lines from the bottom of a context block until it fits within
 * the token budget. Preserves the header and as many entries as possible.
 */
export function truncateToTokenBudget(lines: string[], budgetTokens: number): string[] {
  const result: string[] = [];
  let used = 0;

  for (const line of lines) {
    const cost = estimateTokens(line + "\n");
    if (used + cost > budgetTokens) break;
    result.push(line);
    used += cost;
  }

  return result;
}
