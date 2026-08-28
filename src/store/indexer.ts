import fs from "node:fs";
import type { PiSessionManagerSnapshot, PiSource } from "../sources/pi-source.js";
import type { NormalizedSession, SessionSource } from "../types.js";
import { DatabaseManager } from "./database.js";

const LAST_BACKFILL_KEY = "last_backfill";
const BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface BulkIndexResult {
  filesProcessed: number;
  sessionsIndexed: number;
  filesSkipped: number;
  messagesIndexed: number;
  errors: string[];
  reachedLimit: boolean;
}

interface FileMetadata {
  path: string;
  size: number;
  mtimeMs: number;
}

function sessionId(session: NormalizedSession): string {
  return `${session.source}:${session.nativeId}`;
}

function messageId(session: NormalizedSession, nativeMessageId: string): string {
  return `${sessionId(session)}:${nativeMessageId}`;
}

export function truncateMessage(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const notice = `\n... (truncated, ${content.length} chars total)\n`;
  const retained = Math.max(0, maxChars - notice.length);
  const prefix = Math.ceil(retained / 2);
  const suffix = Math.floor(retained / 2);
  return `${content.slice(0, prefix)}${notice}${suffix > 0 ? content.slice(-suffix) : ""}`;
}

type SessionDatabase = ReturnType<DatabaseManager["getDb"]>;

function writeSessionRows(db: SessionDatabase, session: NormalizedSession, maxMessageChars: number): number {
  const id = sessionId(session);
  const before = (db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?").get(id) as { count: number }).count;

  db.prepare(`
    INSERT INTO sessions (id, source, native_id, project, cwd, started_at, ended_at, message_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      project = excluded.project,
      cwd = excluded.cwd,
      ended_at = excluded.ended_at
  `).run(id, session.source, session.nativeId, session.project, session.cwd, session.startedAt, session.endedAt);

  const upsertMessage = db.prepare(`
    INSERT INTO messages (id, native_id, session_id, role, content, timestamp, tool_calls)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      role = excluded.role,
      content = excluded.content,
      timestamp = excluded.timestamp,
      tool_calls = excluded.tool_calls
  `);
  for (const message of session.messages) {
    upsertMessage.run(
      messageId(session, message.nativeId),
      message.nativeId,
      id,
      message.role,
      truncateMessage(message.content, maxMessageChars),
      message.timestamp,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
    );
  }

  const currentMessageIds = new Set(session.messages.map((message) => messageId(session, message.nativeId)));
  const existingMessageIds = db.prepare("SELECT id FROM messages WHERE session_id = ?").all(id) as Array<{ id: string }>;
  const deleteMessage = db.prepare("DELETE FROM messages WHERE id = ?");
  for (const existing of existingMessageIds) {
    if (!currentMessageIds.has(existing.id)) deleteMessage.run(existing.id);
  }

  db.prepare(`
    UPDATE sessions
    SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?)
    WHERE id = ?
  `).run(id, id);

  const after = (db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?").get(id) as { count: number }).count;
  return Math.max(0, after - before);
}

export function indexSession(dbManager: DatabaseManager, session: NormalizedSession, maxMessageChars: number): number {
  const db = dbManager.getDb();
  const write = db.transaction(() => writeSessionRows(db, session, maxMessageChars));
  const inserted = write();
  dbManager.secureFiles();
  return inserted;
}

function metadata(filePath: string): FileMetadata {
  const stat = fs.statSync(filePath);
  return { path: filePath, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
}

function isUnchanged(dbManager: DatabaseManager, source: string, file: FileMetadata): boolean {
  const row = dbManager.getDb().prepare(
    "SELECT size, mtime_ms FROM session_files WHERE source = ? AND path = ?",
  ).get(source, file.path) as { size: number; mtime_ms: number } | undefined;
  return Boolean(row && row.size === file.size && row.mtime_ms === file.mtimeMs);
}

function recordFileRows(db: SessionDatabase, source: string, file: FileMetadata, id: string): void {
  const previous = db.prepare(
    "SELECT session_id FROM session_files WHERE source = ? AND path = ?",
  ).get(source, file.path) as { session_id: string } | undefined;
  db.prepare(`
    INSERT INTO session_files (source, path, session_id, size, mtime_ms, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, path) DO UPDATE SET
      session_id = excluded.session_id,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      indexed_at = excluded.indexed_at
  `).run(source, file.path, id, file.size, file.mtimeMs, new Date().toISOString());
  if (previous && previous.session_id !== id) deleteSessionWithoutFiles(db, previous.session_id);
}

function deleteSessionWithoutFiles(db: ReturnType<DatabaseManager["getDb"]>, id: string): void {
  const references = (db.prepare("SELECT COUNT(*) AS count FROM session_files WHERE session_id = ?").get(id) as { count: number }).count;
  if (references === 0) db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

function reconcileDeletedFiles(dbManager: DatabaseManager, source: SessionSource, currentPaths: Set<string>): void {
  const db = dbManager.getDb();
  const stored = db.prepare("SELECT path, session_id FROM session_files WHERE source = ?").all(source.id) as Array<{
    path: string;
    session_id: string;
  }>;
  const reconcile = db.transaction(() => {
    for (const row of stored) {
      if (currentPaths.has(row.path)) continue;
      db.prepare("DELETE FROM session_files WHERE source = ? AND path = ?").run(source.id, row.path);
      deleteSessionWithoutFiles(db, row.session_id);
    }
  });
  reconcile();
}

function sameMetadata(left: FileMetadata, right: FileMetadata): boolean {
  return left.path === right.path && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function indexStableFile(
  dbManager: DatabaseManager,
  source: SessionSource,
  expected: FileMetadata,
  session: NormalizedSession,
  maxMessageChars: number,
): number | null {
  const db = dbManager.getDb();
  const apply = db.transaction(() => {
    const current = metadata(expected.path);
    if (!sameMetadata(expected, current)) return null;
    const inserted = writeSessionRows(db, session, maxMessageChars);
    recordFileRows(db, source.id, expected, sessionId(session));
    return inserted;
  });
  const result = apply.immediate();
  dbManager.secureFiles();
  return result;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function indexChangedFiles(
  dbManager: DatabaseManager,
  source: SessionSource,
  maxMessageChars: number,
  maxFiles = Number.POSITIVE_INFINITY,
): Promise<BulkIndexResult> {
  const result: BulkIndexResult = {
    filesProcessed: 0,
    sessionsIndexed: 0,
    filesSkipped: 0,
    messagesIndexed: 0,
    errors: [],
    reachedLimit: false,
  };
  const changed: FileMetadata[] = [];
  const files = source.listFiles();
  reconcileDeletedFiles(dbManager, source, new Set(files));

  for (const filePath of files) {
    try {
      const file = metadata(filePath);
      if (isUnchanged(dbManager, source.id, file)) result.filesSkipped += 1;
      else changed.push(file);
    } catch (error) {
      result.errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  changed.sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const file of changed) {
    if (result.filesProcessed >= maxFiles) {
      result.reachedLimit = true;
      break;
    }
    result.filesProcessed += 1;
    try {
      const session = source.parseFile(file.path);
      if (!session) throw new Error("invalid session header");
      const afterRead = metadata(file.path);
      if (!sameMetadata(file, afterRead)) throw new Error("transcript changed while reading; deferred");
      const inserted = indexStableFile(dbManager, source, file, session, maxMessageChars);
      if (inserted === null) throw new Error("transcript changed before commit; deferred");
      result.sessionsIndexed += 1;
      result.messagesIndexed += inserted;
    } catch (error) {
      result.errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (result.filesProcessed % 10 === 0) await yieldToEventLoop();
  }
  return result;
}

export function indexLivePiSession(
  dbManager: DatabaseManager,
  source: PiSource,
  sessionManager: PiSessionManagerSnapshot,
  maxMessageChars: number,
): number {
  const sessionFile = sessionManager.getSessionFile?.();
  if (sessionFile && fs.existsSync(sessionFile)) {
    const beforeRead = metadata(sessionFile);
    const session = source.parseFile(sessionFile);
    if (session) {
      const afterRead = metadata(sessionFile);
      if (!sameMetadata(beforeRead, afterRead)) return 0;
      return indexStableFile(dbManager, source, beforeRead, session, maxMessageChars) ?? 0;
    }
  }
  const snapshot = source.parseSnapshot(sessionManager);
  return snapshot ? indexSession(dbManager, snapshot, maxMessageChars) : 0;
}

export function needsBackfill(dbManager: DatabaseManager, source: SessionSource, now = Date.now()): boolean {
  const files = source.listFiles();
  const currentPaths = new Set(files);
  const storedPaths = dbManager.getDb().prepare("SELECT path FROM session_files WHERE source = ?").all(source.id) as Array<{ path: string }>;
  if (storedPaths.some((row) => !currentPaths.has(row.path))) return true;
  for (const filePath of files) {
    try {
      if (!isUnchanged(dbManager, source.id, metadata(filePath))) return true;
    } catch {
      return true;
    }
  }
  const row = dbManager.getDb().prepare(
    "SELECT value FROM extension_metadata WHERE source = ? AND key = ?",
  ).get(source.id, LAST_BACKFILL_KEY) as { value: string } | undefined;
  const previous = row ? Date.parse(row.value) : Number.NaN;
  return !Number.isFinite(previous) || now - previous >= BACKFILL_INTERVAL_MS;
}

export function markBackfill(dbManager: DatabaseManager, source: SessionSource, date = new Date()): void {
  dbManager.getDb().prepare(`
    INSERT INTO extension_metadata (source, key, value) VALUES (?, ?, ?)
    ON CONFLICT(source, key) DO UPDATE SET value = excluded.value
  `).run(source.id, LAST_BACKFILL_KEY, date.toISOString());
}

export function getIndexStats(dbManager: DatabaseManager): { sessions: number; messages: number; projects: number } {
  return dbManager.getDb().prepare(`
    SELECT
      (SELECT COUNT(*) FROM sessions) AS sessions,
      (SELECT COUNT(*) FROM messages) AS messages,
      (SELECT COUNT(DISTINCT project) FROM sessions) AS projects
  `).get() as { sessions: number; messages: number; projects: number };
}
