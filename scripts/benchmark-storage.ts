import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = ".pi-session-search-benchmark";

function sameOrNested(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

export function resetBenchmarkStorage(input: string, protectedPaths: string[] = []): string {
  const target = path.resolve(input);
  const cwd = path.resolve(process.cwd());
  const home = path.resolve(os.homedir());
  const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"));
  const sourcePaths = protectedPaths.map((value) => path.resolve(value));

  if (target === path.parse(target).root) throw new Error("Refusing to use the filesystem root as benchmark storage.");
  for (const protectedPath of [cwd, home]) {
    if (sameOrNested(protectedPath, target)) {
      throw new Error(`Refusing unsafe benchmark storage path: ${target}`);
    }
  }
  for (const protectedPath of [agentDir, ...sourcePaths]) {
    if (sameOrNested(protectedPath, target) || sameOrNested(target, protectedPath)) {
      throw new Error(`Refusing unsafe benchmark storage path: ${target}`);
    }
  }

  const segments = target.split(path.sep);
  const dedicatedName = path.basename(target).startsWith("pi-session-search-benchmark-");
  if (!segments.includes(".scratchpad") && !dedicatedName) {
    throw new Error("Benchmark storage must be inside a .scratchpad directory or use a pi-session-search-benchmark-* basename.");
  }

  if (fs.existsSync(target)) {
    const marker = path.join(target, MARKER);
    if (!fs.existsSync(marker)) {
      throw new Error(`Refusing to delete unmarked benchmark directory: ${target}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }

  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(target, MARKER), "generated benchmark storage\n", { mode: 0o600 });
  return target;
}
