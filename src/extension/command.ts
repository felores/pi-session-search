import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiSource } from "../sources/pi-source.js";
import { DatabaseManager } from "../store/database.js";
import { getIndexStats, indexChangedFiles, markBackfill } from "../store/indexer.js";

export function registerIndexCommand(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  source: PiSource,
  maxMessageChars: number,
): void {
  pi.registerCommand("session-index", {
    description: "Incrementally index local Pi session transcripts",
    handler: async (_args, ctx) => {
      try {
        const result = await indexChangedFiles(dbManager, source, maxMessageChars);
        if (result.errors.length === 0) markBackfill(dbManager, source);
        const stats = getIndexStats(dbManager);
        const message = [
          `Session Search indexed ${result.sessionsIndexed} changed session(s) and ${result.messagesIndexed} new message(s).`,
          `Index totals: ${stats.sessions} sessions, ${stats.messages} messages, ${stats.projects} projects.`,
          result.errors.length > 0 ? `${result.errors.length} transcript(s) could not be indexed.` : "",
        ].filter(Boolean).join("\n");
        if (ctx.hasUI) ctx.ui.notify(message, result.errors.length > 0 ? "warning" : "info");
      } catch (error) {
        const message = `Session Search indexing failed: ${error instanceof Error ? error.message : String(error)}`;
        if (ctx.hasUI) ctx.ui.notify(message, "error");
      }
    },
  });
}
