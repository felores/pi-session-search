import { DatabaseManager } from "./database.js";
import {
  fallbackFts5Query,
  hasExplicitFts5Operator,
  isFts5QueryError,
  naturalLanguageFts5Query,
  naturalLanguageTerms,
  normalizeFts5Query,
} from "./fts-query.js";

export interface SessionSearchResult {
  sessionId: string;
  source: string;
  project: string;
  cwd: string;
  role: string;
  content: string;
  timestamp: string;
}

export interface SearchOptions {
  limit?: number;
  project?: string;
  role?: string;
  since?: string;
  source?: string;
}

type Match = { type: "fts"; query: string; order: "recency" | "relevance" } | { type: "like"; terms: string[] };

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function searchSessions(
  dbManager: DatabaseManager,
  query: string,
  options: SearchOptions = {},
): SessionSearchResult[] {
  if (!query.trim()) return [];
  const db = dbManager.getDb();
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 10), 1), 100);
  let ftsParseError = false;

  const execute = (match: Match): SessionSearchResult[] => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (match.type === "fts") {
      conditions.push(match.order === "relevance"
        ? "message_fts MATCH ?"
        : "m.rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?)");
      params.push(match.query);
    } else {
      if (match.terms.length === 0) return [];
      conditions.push(`(${match.terms.map(() => "m.content LIKE ? ESCAPE '\\'").join(" OR ")})`);
      params.push(...match.terms.map((term) => `%${escapeLike(term)}%`));
    }

    if (options.project) {
      conditions.push("s.project = ?");
      params.push(options.project);
    }
    if (options.role) {
      conditions.push("m.role = ?");
      params.push(options.role);
    }
    if (options.since) {
      conditions.push("m.timestamp >= ?");
      params.push(options.since);
    }
    if (options.source) {
      conditions.push("s.source = ?");
      params.push(options.source);
    }

    try {
      const fromClause = match.type === "fts" && match.order === "relevance"
        ? "FROM message_fts JOIN messages m ON m.rowid = message_fts.rowid"
        : "FROM messages m";
      const orderClause = match.type === "fts" && match.order === "relevance"
        ? "ORDER BY bm25(message_fts) ASC, m.timestamp DESC"
        : "ORDER BY m.timestamp DESC";
      return db.prepare(`
        SELECT m.session_id, s.source, s.project, s.cwd, m.role, m.content, m.timestamp
        ${fromClause}
        JOIN sessions s ON s.id = m.session_id
        WHERE ${conditions.join(" AND ")}
        ${orderClause}
        LIMIT ?
      `).all(...params, limit).map((row) => {
        const value = row as Record<string, string>;
        return {
          sessionId: value.session_id,
          source: value.source,
          project: value.project,
          cwd: value.cwd,
          role: value.role,
          content: value.content,
          timestamp: value.timestamp,
        };
      });
    } catch (error) {
      if (match.type === "fts" && isFts5QueryError(error)) {
        ftsParseError = true;
        return [];
      }
      throw error;
    }
  };

  const normalized = normalizeFts5Query(query);
  if (!normalized) return [];
  const exact = execute({ type: "fts", query: normalized, order: "recency" });
  if (exact.length > 0) return exact;

  if (hasExplicitFts5Operator(query)) {
    if (!ftsParseError) return [];
    const natural = naturalLanguageFts5Query(query);
    if (natural && natural !== normalized) {
      const recovered = execute({ type: "fts", query: natural, order: "recency" });
      if (recovered.length > 0) return recovered;
      const broad = fallbackFts5Query(query, true);
      if (broad && broad !== natural) {
        const broadResults = execute({ type: "fts", query: broad, order: "relevance" });
        if (broadResults.length > 0) return broadResults;
      }
    }
    return execute({ type: "like", terms: naturalLanguageTerms(query) });
  }

  const fallback = fallbackFts5Query(query);
  if (fallback && fallback !== normalized) {
    const broad = execute({ type: "fts", query: fallback, order: "relevance" });
    if (broad.length > 0) return broad;
  }
  return execute({ type: "like", terms: naturalLanguageTerms(query) });
}

export function indexedMessageCount(dbManager: DatabaseManager): number {
  return (dbManager.getDb().prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count;
}

const MAX_QUERY_VARIANTS = 3;
const EXPANDED_CANDIDATE_LIMIT = 100;

/**
 * Search an original query plus agent-supplied translations or paraphrases.
 * Source-language variants are interleaved before the original-language query,
 * then deduplicated by session. A single query delegates directly to
 * searchSessions so the established lexical ordering is unchanged when
 * expansion is not requested.
 */
export function searchSessionsExpanded(
  dbManager: DatabaseManager,
  query: string,
  queryVariants: string[] = [],
  options: SearchOptions = {},
): SessionSearchResult[] {
  const original = query.trim();
  const variants: string[] = [];
  const seenQueries = new Set<string>();
  for (const candidate of queryVariants.slice(0, MAX_QUERY_VARIANTS)) {
    const trimmed = candidate.trim();
    const key = trimmed.toLocaleLowerCase();
    if (!trimmed || seenQueries.has(key)) continue;
    seenQueries.add(key);
    variants.push(trimmed);
  }
  if (!original || variants.length === 0) return searchSessions(dbManager, query, options);
  const queries = [...variants.filter((variant) => variant.toLocaleLowerCase() !== original.toLocaleLowerCase()), original];
  if (queries.length <= 1) return searchSessions(dbManager, query, options);

  const requestedLimit = Math.min(Math.max(Math.floor(options.limit ?? 10), 1), 20);
  const rankedLists = queries.map((expandedQuery) => {
    const results = searchSessions(dbManager, expandedQuery, {
      ...options,
      limit: EXPANDED_CANDIDATE_LIMIT,
    });
    const seenSessions = new Set<string>();
    return results.filter((result) => {
      if (seenSessions.has(result.sessionId)) return false;
      seenSessions.add(result.sessionId);
      return true;
    });
  });

  const output: SessionSearchResult[] = [];
  const emittedSessions = new Set<string>();
  for (let rank = 0; output.length < requestedLimit; rank += 1) {
    let foundAtRank = false;
    for (const list of rankedLists) {
      const result = list[rank];
      if (!result) continue;
      foundAtRank = true;
      if (emittedSessions.has(result.sessionId)) continue;
      emittedSessions.add(result.sessionId);
      output.push(result);
      if (output.length >= requestedLimit) break;
    }
    if (!foundAtRank) break;
  }
  return output;
}
