import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PiSource } from "../src/sources/pi-source.js";
import { DatabaseManager } from "../src/store/database.js";
import { getIndexStats, indexChangedFiles } from "../src/store/indexer.js";
import { searchSessions } from "../src/store/search.js";
import { resetBenchmarkStorage } from "./benchmark-storage.js";

interface QueryItem {
  id: string;
  query: string;
  relevantSessions: string[];
}

interface QueryFile {
  queries: QueryItem[];
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function percentile(values: number[], probability: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * probability) - 1)] ?? 0;
}

const sessionsDir = argument("--sessions");
const queriesPath = argument("--queries");
const storageDir = argument("--storage");
const outputPath = argument("--output");
const gate = process.argv.includes("--gate");
if (!sessionsDir || !queriesPath || !storageDir) {
  throw new Error("Usage: npm run benchmark -- --sessions <dir> --queries <queries.json> --storage <dir> [--output <file>]");
}

const safeStorageDir = resetBenchmarkStorage(storageDir, [sessionsDir]);
const dbManager = new DatabaseManager(safeStorageDir);
const source = new PiSource(sessionsDir);
const indexStarted = performance.now();
const indexResult = await indexChangedFiles(dbManager, source, 100 * 1024);
const indexingMs = performance.now() - indexStarted;
const queries = (JSON.parse(fs.readFileSync(queriesPath, "utf8")) as QueryFile).queries;

const ranks: Array<number | null> = [];
for (const query of queries) {
  const results = searchSessions(dbManager, query.query, { limit: 80 });
  const uniqueSessions = [...new Set(results.map((result) => result.sessionId.replace(/^pi:/, "")))].slice(0, 10);
  const rank = uniqueSessions.findIndex((id) => query.relevantSessions.includes(id));
  ranks.push(rank >= 0 ? rank + 1 : null);
}

const latencySamples: number[] = [];
for (let repetition = 0; repetition < 100; repetition += 1) {
  for (const query of queries) {
    const started = performance.now();
    searchSessions(dbManager, query.query, { limit: 80 });
    latencySamples.push(performance.now() - started);
  }
}

const stats = getIndexStats(dbManager);
dbManager.close();
const indexBytes = fs.statSync(path.join(safeStorageDir, "index.sqlite")).size;
const foundRanks = ranks.filter((rank): rank is number => rank !== null);
const result = {
  schema: "pi-session-search-benchmark-v1",
  queries: queries.length,
  effectiveness: {
    rank1: ranks.filter((rank) => rank === 1).length / ranks.length,
    recallAt5: ranks.filter((rank) => rank !== null && rank <= 5).length / ranks.length,
    recallAt10: foundRanks.length / ranks.length,
    mrr: ranks.reduce<number>((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length,
    misses: ranks.filter((rank) => rank === null).length,
    ranks,
  },
  latency: {
    samples: latencySamples.length,
    p50Ms: percentile(latencySamples, 0.5),
    p95Ms: percentile(latencySamples, 0.95),
    p99Ms: percentile(latencySamples, 0.99),
  },
  index: {
    indexingMs,
    indexBytes,
    stats,
    filesProcessed: indexResult.filesProcessed,
    errors: indexResult.errors,
  },
};

const output = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, { mode: 0o600 });
}
process.stdout.write(output);

if (gate) {
  const failures: string[] = [];
  if (result.effectiveness.rank1 < 0.875) failures.push(`Rank@1 ${result.effectiveness.rank1} < 0.875`);
  if (result.effectiveness.recallAt10 < 1) failures.push(`Recall@10 ${result.effectiveness.recallAt10} < 1`);
  if (result.latency.p95Ms > 1.5) failures.push(`p95 ${result.latency.p95Ms}ms > 1.5ms`);
  if (result.index.indexBytes > 50 * 1024 * 1024) failures.push(`index ${result.index.indexBytes} bytes > 50 MiB`);
  if (result.index.errors.length > 0) failures.push(`${result.index.errors.length} indexing errors`);
  if (failures.length > 0) throw new Error(`Benchmark gate failed:\n- ${failures.join("\n- ")}`);
}
