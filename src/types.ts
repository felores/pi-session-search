export type SessionRole = "user" | "assistant" | "system";

export interface NormalizedMessage {
  nativeId: string;
  role: SessionRole;
  content: string;
  timestamp: string;
  toolCalls?: string[];
}

export interface NormalizedSession {
  source: string;
  nativeId: string;
  project: string;
  cwd: string;
  startedAt: string;
  endedAt: string | null;
  messages: NormalizedMessage[];
}

export interface SessionSource {
  readonly id: string;
  listFiles(): string[];
  parseFile(filePath: string): NormalizedSession | null;
}

export interface SessionSearchConfig {
  storageDir: string;
  sessionsDir: string;
  startupMaxFiles: number;
  liveIndexDelayMs: number;
  maxMessageChars: number;
}
