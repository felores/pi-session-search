import fs from "node:fs";
import path from "node:path";
import type { NormalizedMessage, NormalizedSession, SessionSource } from "../types.js";

interface JsonlEntry {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
}

export interface PiSessionManagerSnapshot {
  getHeader(): { id: string; timestamp: string; cwd: string } | null;
  getEntries(): unknown[];
  getSessionFile?(): string | undefined;
}

function visibleText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const candidate = block as Record<string, unknown>;
    if (candidate.type === "text" && typeof candidate.text === "string") {
      parts.push(candidate.text);
    }
  }
  return parts.join("\n").trim();
}

function toolNames(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const names: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const candidate = block as Record<string, unknown>;
    if ((candidate.type === "toolCall" || candidate.type === "tool_use") && typeof candidate.name === "string") {
      names.push(candidate.name);
    }
  }
  return names.length > 0 ? names : undefined;
}

function parseMessage(entry: JsonlEntry): NormalizedMessage | null {
  if (entry.type !== "message" || typeof entry.id !== "string" || typeof entry.timestamp !== "string" || !entry.message) {
    return null;
  }
  const role = entry.message.role;
  if (role !== "user" && role !== "assistant" && role !== "system") return null;
  const content = visibleText(entry.message.content);
  if (!content) return null;

  return {
    nativeId: entry.id,
    role,
    content,
    timestamp: entry.timestamp,
    toolCalls: role === "assistant" ? toolNames(entry.message.content) : undefined,
  };
}

function projectFromCwd(cwd: string): string {
  return path.basename(cwd) || cwd;
}

export class PiSource implements SessionSource {
  readonly id = "pi";

  constructor(readonly sessionsDir: string) {}

  listFiles(): string[] {
    if (!fs.existsSync(this.sessionsDir)) return [];
    const files: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "subagent-artifacts") continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(absolute);
      }
    };
    visit(this.sessionsDir);
    return files;
  }

  parseFile(filePath: string): NormalizedSession | null {
    const text = fs.readFileSync(filePath, "utf8");
    let nativeId: string | null = null;
    let cwd: string | null = null;
    let startedAt: string | null = null;
    const messages: NormalizedMessage[] = [];

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: JsonlEntry;
      try {
        entry = JSON.parse(line) as JsonlEntry;
      } catch {
        continue;
      }

      if (entry.type === "session") {
        nativeId = typeof entry.id === "string" ? entry.id : nativeId;
        cwd = typeof entry.cwd === "string" ? entry.cwd : cwd;
        startedAt = typeof entry.timestamp === "string" ? entry.timestamp : startedAt;
        continue;
      }

      const message = parseMessage(entry);
      if (message) messages.push(message);
    }

    if (!nativeId || !cwd || !startedAt) return null;
    return {
      source: this.id,
      nativeId,
      project: projectFromCwd(cwd),
      cwd,
      startedAt,
      endedAt: messages.at(-1)?.timestamp ?? null,
      messages,
    };
  }

  parseSnapshot(sessionManager: PiSessionManagerSnapshot): NormalizedSession | null {
    const header = sessionManager.getHeader();
    if (!header?.id || !header.cwd || !header.timestamp) return null;
    const messages = sessionManager.getEntries()
      .map((entry) => parseMessage(entry as JsonlEntry))
      .filter((message): message is NormalizedMessage => message !== null);

    return {
      source: this.id,
      nativeId: header.id,
      project: projectFromCwd(header.cwd),
      cwd: header.cwd,
      startedAt: header.timestamp,
      endedAt: messages.at(-1)?.timestamp ?? null,
      messages,
    };
  }
}
