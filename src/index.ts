import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { registerIndexCommand } from "./extension/command.js";
import { IndexScheduler } from "./extension/scheduler.js";
import { registerSessionSearchTool } from "./extension/tool.js";
import { PiSource } from "./sources/pi-source.js";
import { DatabaseManager } from "./store/database.js";
import { indexLivePiSession } from "./store/indexer.js";

export default function sessionSearchExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const dbManager = new DatabaseManager(config.storageDir);
  const source = new PiSource(config.sessionsDir);
  const scheduler = new IndexScheduler(dbManager, source, config.maxMessageChars);
  const warn = (ctx: { hasUI: boolean; ui: { notify(message: string, level: "warning"): void } }) =>
    (message: string): void => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    };

  registerSessionSearchTool(pi, dbManager);
  registerIndexCommand(pi, dbManager, source, config.maxMessageChars);

  pi.on("session_start", async (_event, ctx) => {
    scheduler.scheduleBackfill(config.startupMaxFiles, warn(ctx));
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "user" && event.message.role !== "assistant") return;
    scheduler.scheduleLive(ctx.sessionManager, config.liveIndexDelayMs, warn(ctx));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await scheduler.flush();
    try {
      indexLivePiSession(dbManager, source, ctx.sessionManager, config.maxMessageChars);
    } catch (error) {
      warn(ctx)(`Session Search final index failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      dbManager.close();
    }
  });
}
