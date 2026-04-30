import type { IdentityModel } from "../shared/types";
import { extractKeywords, keywordOverlap } from "../shared/keywords";
import { estimateTokens, truncateToTokenBudget } from "../shared/tokenizer";

const HEADER = "[Ambi Context]";
const FOOTER = "[End Ambi Context]";

/**
 * Build a ranked, token-budgeted context string to prepend to a user's prompt.
 */
export function buildContext(
  model: IdentityModel,
  promptText: string,
  budgetTokens: number
): string {
  const promptKeywords = extractKeywords(promptText);

  const lines: string[] = [HEADER];

  // 1. Active projects (ranked by overlap with current prompt, then by weight)
  const rankedProjects = [...model.activeProjects]
    .map((p) => ({ p, score: keywordOverlap(promptKeywords, p.keywords) * 10 + p.weight }))
    .sort((a, b) => b.score - a.score)
    .map(({ p }) => p);

  if (rankedProjects.length > 0) {
    lines.push("Working on:");
    for (const project of rankedProjects) {
      lines.push(`  • ${project.label}`);
    }
  }

  // 2. Recurring topics (top by hits, filtered for relevance)
  const relevantTopics = model.recurringTopics
    .filter((t) => promptKeywords.length === 0 || keywordOverlap(promptKeywords, t.keywords) > 0 || t.hits >= 3)
    .slice(0, 5)
    .map((t) => t.label);

  if (relevantTopics.length > 0) {
    lines.push("Recurring topics: " + relevantTopics.join(", "));
  }

  // 3. Open threads
  if (model.openThreads.length > 0) {
    lines.push("Open questions:");
    for (const thread of model.openThreads) {
      lines.push(`  • ${thread.text}`);
    }
  }

  // 4. Recent questions (most recent first, top 3)
  const recentQs = model.recentQuestions.slice(0, 3);
  if (recentQs.length > 0) {
    lines.push("Recently asked:");
    for (const q of recentQs) {
      const ago = formatAgo(q.ts);
      lines.push(`  • "${q.text}" (${ago})`);
    }
  }

  lines.push(FOOTER);

  // Enforce token budget — truncate from bottom, but always keep header/footer
  const bodyLines = lines.slice(1, -1);
  const truncated = truncateToTokenBudget(bodyLines, budgetTokens - estimateTokens(HEADER + "\n" + FOOTER + "\n"));

  if (truncated.length === 0) return "";

  return [HEADER, ...truncated, FOOTER].join("\n");
}

function formatAgo(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
