import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resetBenchmarkStorage } from "../scripts/benchmark-storage.js";

test("benchmark storage resets only a marked dedicated directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-search-storage-test-"));
  const target = path.join(root, ".scratchpad", "run", "store");
  try {
    assert.equal(resetBenchmarkStorage(target), path.resolve(target));
    fs.writeFileSync(path.join(target, "temporary.txt"), "temporary");
    resetBenchmarkStorage(target);
    assert.equal(fs.existsSync(path.join(target, "temporary.txt")), false);
    assert.equal(fs.existsSync(path.join(target, ".pi-session-search-benchmark")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("benchmark storage refuses protected and unmarked paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-search-storage-test-"));
  const unmarked = path.join(root, ".scratchpad", "unmarked");
  fs.mkdirSync(unmarked, { recursive: true });
  try {
    assert.throws(() => resetBenchmarkStorage(process.cwd()), /unsafe benchmark storage/);
    assert.throws(() => resetBenchmarkStorage(os.homedir()), /unsafe benchmark storage/);
    assert.throws(() => resetBenchmarkStorage(unmarked), /unmarked benchmark directory/);
    assert.throws(() => resetBenchmarkStorage(path.join(root, "ordinary-name")), /must be inside a \.scratchpad/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
