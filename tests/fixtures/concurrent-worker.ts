import { setTimeout as delay } from "node:timers/promises";
import { PiSource } from "../../src/sources/pi-source.js";
import { DatabaseManager } from "../../src/store/database.js";
import { indexChangedFiles } from "../../src/store/indexer.js";

const [storageDir, sessionsDir] = process.argv.slice(2);
if (!storageDir || !sessionsDir) throw new Error("storage and sessions arguments are required");

const manager = new DatabaseManager(storageDir);
await indexChangedFiles(manager, new PiSource(sessionsDir), 100 * 1024);
process.stdout.write("READY\n");
await delay(500);
manager.close();
