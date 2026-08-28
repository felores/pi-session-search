import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-search-smoke-"));
const storage = path.join(scratch, "store");
const sessions = path.join(scratch, "sessions");
fs.mkdirSync(sessions, { recursive: true });

try {
  const executable = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  const result = spawnSync(executable, [
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "-e",
    path.join(root, "src", "index.ts"),
    "--list-models",
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PI_SESSION_SEARCH_DIR: storage,
      PI_CODING_AGENT_SESSION_DIR: sessions,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(storage, "index.sqlite")), false, "extension factory performed storage I/O");
  process.stdout.write("Pi extension load smoke passed\n");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
