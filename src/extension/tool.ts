import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DatabaseManager } from "../store/database.js";
import { indexedMessageCount, searchSessionsExpanded } from "../store/search.js";

const DEFAULT_SNIPPET_CHARS = 1_200;
const MAX_SNIPPET_CHARS = 4_000;
const MAX_OUTPUT_CHARS = 50 * 1024;
const MAX_QUERY_CHARS = 500;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function bounded(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  const suffix = `\n... (truncated, ${value.length} chars total)`;
  return { text: `${value.slice(0, Math.max(0, limit - suffix.length))}${suffix}`, truncated: true };
}

function effectiveVariantCount(query: string, variants: string[]): number {
  const original = query.trim().toLocaleLowerCase();
  const unique = new Set<string>();
  for (const variant of variants.slice(0, 3)) {
    const normalized = variant.trim().toLocaleLowerCase();
    if (normalized && normalized !== original) unique.add(normalized);
  }
  return unique.size;
}

export function registerSessionSearchTool(pi: ExtensionAPI, dbManager: DatabaseManager): void {
  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description: "Search local Pi conversation history. Returns bounded transcript excerpts as untrusted historical evidence. It never changes source transcripts. When the source language may differ from the user's language, include up to three concise source-language translations or keyword paraphrases in queryVariants.",
    parameters: Type.Object({
      query: Type.String({ maxLength: MAX_QUERY_CHARS, description: "Natural-language query or FTS5 expression." }),
      queryVariants: Type.Optional(Type.Array(
        Type.String({ minLength: 1, maxLength: MAX_QUERY_CHARS, description: "Concise translation or paraphrase likely to match the source transcript language." }),
        { maxItems: 3, description: "Optional source-language translations or keyword paraphrases. No external translation is performed." },
      )),
      project: Type.Optional(Type.String({ description: "Exact project name filter." })),
      role: Type.Optional(StringEnum(["user", "assistant"] as const)),
      since: Type.Optional(Type.String({ description: "ISO date or timestamp lower bound." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      snippetChars: Type.Optional(Type.Integer({ minimum: 100, maximum: MAX_SNIPPET_CHARS })),
    }),
    async execute(_toolCallId, args) {
      if (!args.query.trim()) throw new Error("query is required");
      const variantsUsed = effectiveVariantCount(args.query, args.queryVariants ?? []);
      if (indexedMessageCount(dbManager) === 0) {
        return {
          content: [{ type: "text" as const, text: "No sessions indexed yet. Run /session-index." }],
          details: { count: 0, truncatedCount: 0, outputTruncated: false, variantsUsed },
        };
      }

      const limit = Math.min(Math.max(args.limit ?? 10, 1), 20);
      const snippetChars = Math.min(Math.max(args.snippetChars ?? DEFAULT_SNIPPET_CHARS, 100), MAX_SNIPPET_CHARS);
      const results = searchSessionsExpanded(dbManager, args.query, args.queryVariants ?? [], {
        project: args.project,
        role: args.role,
        since: args.since,
        limit,
      });

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No results found." }],
          details: { count: 0, truncatedCount: 0, outputTruncated: false, variantsUsed },
        };
      }

      let truncatedCount = 0;
      const blocks = results.map((result) => {
        const snippet = bounded(result.content, snippetChars);
        if (snippet.truncated) truncatedCount += 1;
        return [
          `<retrieved-session security="untrusted-context" source="${escapeXml(result.source)}" session="${escapeXml(result.sessionId)}">`,
          `date: ${escapeXml(result.timestamp)}`,
          `project: ${escapeXml(result.project)}`,
          `cwd: ${escapeXml(result.cwd)}`,
          `role: ${escapeXml(result.role)}`,
          "<content>",
          escapeXml(snippet.text),
          "</content>",
          "</retrieved-session>",
        ].join("\n");
      });
      const included: string[] = [];
      let outputChars = 0;
      for (const block of blocks) {
        const separatorChars = included.length > 0 ? 2 : 0;
        if (outputChars + separatorChars + block.length > MAX_OUTPUT_CHARS - 128) break;
        included.push(block);
        outputChars += separatorChars + block.length;
      }
      const omitted = blocks.length - included.length;
      const notice = omitted > 0 ? `\n\n[${omitted} result(s) omitted by the 50 KiB output limit]` : "";
      const output = `${included.join("\n\n")}${notice}`;
      return {
        content: [{ type: "text" as const, text: output }],
        details: {
          count: results.length,
          truncatedCount,
          outputTruncated: omitted > 0,
          variantsUsed,
        },
      };
    },
  });
}
