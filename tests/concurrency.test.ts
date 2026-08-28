import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseManager } from "../src/store/database.js";

function sessionFile(directory: string, id: string, text: string): string {
  const file = path.join(directory, `${id}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-20T10:00:00.000Z", cwd: "/workspace/concurrency" }),
    JSON.stringify({
      type: "message",
      id: `${id}-message`,
      timestamp: "2026-08-20T10:00:01.000Z",
      message: { role: "user", content: text },
    }),
  ].join("\n"), "utf8");
  return file;
}

function digest(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function ready(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("READY")) resolve();
    });
    child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}: ${output}`));
    });
  });
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)));
  });
}

test("two Pi processes share WAL safely without mutating transcripts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-search-concurrency-"));
  const sessions = path.join(root, "sessions");
  const storage = path.join(root, "store");
  fs.mkdirSync(sessions, { recursive: true });
  const files = [sessionFile(sessions, "one", "alpha needle"), sessionFile(sessions, "two", "beta needle")];
  const before = files.map((file) => ({ file, hash: digest(file), stat: fs.statSync(file) }));
  const worker = path.join(process.cwd(), "tests", "fixtures", "concurrent-worker.ts");
  const args = ["--import", "tsx", worker, storage, sessions];
  const first = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  const second = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });

  try {
    await Promise.all([ready(first), ready(second)]);
    for (const target of [storage, path.join(storage, "index.sqlite"), path.join(storage, "index.sqlite-wal"), path.join(storage, "index.sqlite-shm")]) {
      assert.equal(fs.statSync(target).mode & 0o777, target === storage ? 0o700 : 0o600, target);
    }
    await Promise.all([exited(first), exited(second)]);

    const manager = new DatabaseManager(storage);
    const db = manager.getDb();
    assert.equal((db.pragma("integrity_check", { simple: true }) as string), "ok");
    const messages = db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number };
    assert.equal(messages.count, 2);
    const matches = db.prepare("SELECT COUNT(*) AS count FROM message_fts WHERE message_fts MATCH ?").get('"needle"') as { count: number };
    assert.equal(matches.count, 2);
    db.prepare("INSERT INTO message_fts(message_fts, rank) VALUES('integrity-check', 1)").run();
    manager.close();

    for (const item of before) {
      const after = fs.statSync(item.file);
      assert.equal(digest(item.file), item.hash);
      assert.equal(after.ino, item.stat.ino);
      assert.equal(after.mode, item.stat.mode);
    }
    assert.deepEqual(fs.readdirSync(root).sort(), ["sessions", "store"]);
  } finally {
    first.kill();
    second.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
