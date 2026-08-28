import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function retryBusy<T>(operation: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") throw error;
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  throw lastError;
}

export class DatabaseManager {
  private db: Database.Database | null = null;
  readonly dbPath: string;

  constructor(readonly storageDir: string) {
    this.dbPath = path.join(storageDir, "index.sqlite");
  }

  getDb(): Database.Database {
    if (this.db) return this.db;

    fs.mkdirSync(this.storageDir, { recursive: true, mode: DIRECTORY_MODE });
    fs.chmodSync(this.storageDir, DIRECTORY_MODE);

    const db = new Database(this.dbPath);
    try {
      db.pragma("busy_timeout = 5000");
      const journalMode = db.pragma("journal_mode", { simple: true }) as string;
      if (journalMode.toLowerCase() !== "wal") retryBusy(() => db.pragma("journal_mode = WAL"));
      db.pragma("foreign_keys = ON");
      retryBusy(() => db.exec(SCHEMA_SQL));
      this.db = db;
      this.secureFiles();
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    if (!this.db) return;
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      this.db.close();
      this.db = null;
      this.secureFiles();
    }
  }

  secureFiles(): void {
    for (const file of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      try {
        fs.chmodSync(file, FILE_MODE);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}
