import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SessionSearchConfig } from "./types.js";

const DEFAULT_STARTUP_MAX_FILES = 50;
const DEFAULT_LIVE_INDEX_DELAY_MS = 50;
const DEFAULT_MAX_MESSAGE_CHARS = 100 * 1024;

type ConfigFile = Partial<Pick<
  SessionSearchConfig,
  "sessionsDir" | "startupMaxFiles" | "liveIndexDelayMs" | "maxMessageChars"
>>;

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

export function defaultAgentRoot(): string {
  return getAgentDir();
}

export function loadConfig(): SessionSearchConfig {
  const agentRoot = defaultAgentRoot();
  const storageDir = process.env.PI_SESSION_SEARCH_DIR || path.join(agentRoot, "session-search");
  const configPath = path.join(storageDir, "config.json");
  let file: ConfigFile = {};

  try {
    if (fs.existsSync(configPath)) {
      file = JSON.parse(fs.readFileSync(configPath, "utf8")) as ConfigFile;
    }
  } catch {
    file = {};
  }

  return {
    storageDir,
    sessionsDir: process.env.PI_CODING_AGENT_SESSION_DIR || file.sessionsDir || path.join(agentRoot, "sessions"),
    startupMaxFiles: positiveInteger(file.startupMaxFiles, DEFAULT_STARTUP_MAX_FILES),
    liveIndexDelayMs: positiveInteger(file.liveIndexDelayMs, DEFAULT_LIVE_INDEX_DELAY_MS),
    maxMessageChars: positiveInteger(file.maxMessageChars, DEFAULT_MAX_MESSAGE_CHARS),
  };
}
