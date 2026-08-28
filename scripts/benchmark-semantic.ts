import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PiSource } from "../src/sources/pi-source.js";
import { DatabaseManager } from "../src/store/database.js";
import { indexChangedFiles } from "../src/store/indexer.js";
import { searchSessionsExpanded } from "../src/store/search.js";
import { resetBenchmarkStorage } from "./benchmark-storage.js";

interface SemanticQuery {
  id: string;
  category: string;
  queryLanguage: string;
  sourceLanguage: string;
  query: string;
  queryVariants?: string[];
  relevantSessions: string[];
}

interface Dataset {
  schema: string;
  queries: SemanticQuery[];
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function metrics(ranks: Array<number | null>) {
  return {
    queries: ranks.length,
    rank1: ranks.filter((rank) => rank === 1).length / ranks.length,
    recallAt5: ranks.filter((rank) => rank !== null && rank <= 5).length / ranks.length,
    recallAt10: ranks.filter((rank) => rank !== null && rank <= 10).length / ranks.length,
    mrr: ranks.reduce<number>((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length,
    misses: ranks.filter((rank) => rank === null).length,
  };
}

const sessionsDir = argument("--sessions");
const datasetPath = argument("--dataset");
const storageDir = argument("--storage");
const outputPath = argument("--output");
if (!sessionsDir || !datasetPath || !storageDir || !outputPath) {
  throw new Error("Usage: npm run benchmark:semantic -- --sessions <dir> --dataset <file> --storage <dir> --output <file>");
}

const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8")) as Dataset;
const safeStorageDir = resetBenchmarkStorage(storageDir, [sessionsDir]);
const manager = new DatabaseManager(safeStorageDir);
const source = new PiSource(sessionsDir);
const indexStarted = performance.now();
const indexResult = await indexChangedFiles(manager, source, 100 * 1024);
const indexingMs = performance.now() - indexStarted;

const cases = dataset.queries.map((item) => {
  const started = performance.now();
  const results = searchSessionsExpanded(manager, item.query, item.queryVariants ?? [], { limit: 20 });
  const latencyMs = performance.now() - started;
  const unique = [...new Set(results.map((result) => result.sessionId.replace(/^pi:/, "")))].slice(0, 10);
  const position = unique.findIndex((session) => item.relevantSessions.includes(session));
  return {
    id: item.id,
    category: item.category,
    queryLanguage: item.queryLanguage,
    sourceLanguage: item.sourceLanguage,
    query: item.query,
    queryVariants: item.queryVariants ?? [],
    rank: position >= 0 ? position + 1 : null,
    topSessions: unique,
    topSnippets: results.slice(0, 3).map((result) => ({
      session: result.sessionId.replace(/^pi:/, ""),
      role: result.role,
      timestamp: result.timestamp,
      text: result.content.replace(/\s+/g, " ").slice(0, 240),
    })),
    latencyMs,
  };
});

const categories = Object.fromEntries(
  [...new Set(cases.map((item) => item.category))].map((category) => [
    category,
    metrics(cases.filter((item) => item.category === category).map((item) => item.rank)),
  ]),
);
const languages = Object.fromEntries(
  [...new Set(cases.map((item) => `${item.queryLanguage}->${item.sourceLanguage}`))].map((direction) => [
    direction,
    metrics(cases
      .filter((item) => `${item.queryLanguage}->${item.sourceLanguage}` === direction)
      .map((item) => item.rank)),
  ]),
);

const result = {
  schema: "pi-session-search-semantic-result-v1",
  dataset: dataset.schema,
  overall: metrics(cases.map((item) => item.rank)),
  categories,
  languages,
  index: {
    indexingMs,
    filesProcessed: indexResult.filesProcessed,
    errors: indexResult.errors,
  },
  cases,
};
manager.close();
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ overall: result.overall, categories, languages }, null, 2)}\n`);
