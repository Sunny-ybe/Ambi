import type {
  IdentityModel,
  ActiveProject,
  RecurringTopic,
  TabVisit,
} from "../shared/types";
import { extractKeywords } from "../shared/keywords";

const MAX_PROJECTS = 5;
const MAX_TOPICS = 10;
const MAX_QUESTIONS = 20;
const MAX_THREADS = 5;

/**
 * Recency-biased weight: hits discounted by hours since last seen.
 */
function computeWeight(hits: number, lastSeen: number): number {
  const hoursAgo = (Date.now() - lastSeen) / 3_600_000;
  return hits / (1 + hoursAgo);
}

/**
 * Ingest a tab visit into the identity model.
 * Updates activeProjects and recurringTopics based on title + URL path.
 */
export function ingestTabVisit(model: IdentityModel, visit: TabVisit): IdentityModel {
  const raw = `${visit.title} ${visit.url}`;
  const keywords = extractKeywords(raw);
  if (keywords.length === 0) return model;

  // Try to match an existing project by keyword overlap
  const now = Date.now();
  let matched = false;

  const activeProjects = model.activeProjects.map((p): ActiveProject => {
    const overlap = keywords.filter((k) => p.keywords.includes(k)).length;
    if (overlap >= 2) {
      matched = true;
      const newKeywords = [...new Set([...p.keywords, ...keywords])].slice(0, 20);
      const hits = (p.weight * (1 + (now - p.lastSeen) / 3_600_000)) + 1;
      return {
        ...p,
        keywords: newKeywords,
        weight: computeWeight(hits, now),
        lastSeen: now,
      };
    }
    return p;
  });

  // If no project matched, seed one from the title
  let finalProjects = activeProjects;
  if (!matched && visit.title.length > 0) {
    const newProject: ActiveProject = {
      label: visit.title.slice(0, 60),
      keywords: keywords.slice(0, 15),
      weight: computeWeight(1, now),
      lastSeen: now,
    };
    finalProjects = [...activeProjects, newProject]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_PROJECTS);
  } else {
    finalProjects = activeProjects
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_PROJECTS);
  }

  // Update recurring topics
  const recurringTopics = updateTopics(model.recurringTopics, keywords, now);

  return { ...model, activeProjects: finalProjects, recurringTopics };
}

/**
 * Ingest a question (from an AI chat) into the identity model.
 */
export function ingestQuestion(
  model: IdentityModel,
  questionText: string
): IdentityModel {
  const keywords = extractKeywords(questionText);
  const now = Date.now();

  const recentQuestions = [
    { text: questionText, ts: now },
    ...model.recentQuestions,
  ].slice(0, MAX_QUESTIONS);

  const recurringTopics = updateTopics(model.recurringTopics, keywords, now);

  return { ...model, recentQuestions, recurringTopics };
}

/**
 * Add a user-defined open thread.
 */
export function addOpenThread(model: IdentityModel, text: string): IdentityModel {
  const openThreads = [
    { text, ts: Date.now() },
    ...model.openThreads,
  ].slice(0, MAX_THREADS);
  return { ...model, openThreads };
}

function updateTopics(
  topics: RecurringTopic[],
  keywords: string[],
  now: number
): RecurringTopic[] {
  const updated = topics.map((t): RecurringTopic => {
    const overlap = keywords.filter((k) => t.keywords.includes(k)).length;
    if (overlap >= 1) {
      return { ...t, hits: t.hits + overlap, lastSeen: now };
    }
    return t;
  });

  // Any keyword not covered by existing topics may seed a new topic
  const coveredKeywords = new Set(updated.flatMap((t) => t.keywords));
  const newKeywords = keywords.filter((k) => !coveredKeywords.has(k));

  let result = updated;
  for (const kw of newKeywords) {
    result = [...result, { label: kw, keywords: [kw], hits: 1, lastSeen: now }];
  }

  return result
    .sort((a, b) => b.hits - a.hits)
    .slice(0, MAX_TOPICS);
}
