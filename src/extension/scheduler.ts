import type { PiSessionManagerSnapshot, PiSource } from "../sources/pi-source.js";
import { DatabaseManager } from "../store/database.js";
import {
  indexChangedFiles,
  indexLivePiSession,
  markBackfill,
  needsBackfill,
} from "../store/indexer.js";

export class IndexScheduler {
  private backfillPending: Promise<void> | null = null;
  private livePending: Promise<void> | null = null;

  constructor(
    private readonly dbManager: DatabaseManager,
    private readonly source: PiSource,
    private readonly maxMessageChars: number,
  ) {}

  scheduleBackfill(maxFiles: number, onWarning?: (message: string) => void): void {
    if (this.backfillPending) return;
    this.backfillPending = new Promise((resolve) => {
      setTimeout(async () => {
        try {
          if (!needsBackfill(this.dbManager, this.source)) return;
          const result = await indexChangedFiles(this.dbManager, this.source, this.maxMessageChars, maxFiles);
          if (!result.reachedLimit && result.errors.length === 0) markBackfill(this.dbManager, this.source);
          if (result.errors.length > 0) onWarning?.(`Session Search skipped ${result.errors.length} unreadable transcript(s).`);
        } catch (error) {
          onWarning?.(`Session Search backfill failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          this.backfillPending = null;
          resolve();
        }
      }, 0);
    });
  }

  scheduleLive(sessionManager: PiSessionManagerSnapshot, delayMs: number, onWarning?: (message: string) => void): void {
    if (this.livePending) return;
    this.livePending = new Promise((resolve) => {
      setTimeout(() => {
        try {
          indexLivePiSession(this.dbManager, this.source, sessionManager, this.maxMessageChars);
        } catch (error) {
          onWarning?.(`Session Search live index failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          this.livePending = null;
          resolve();
        }
      }, delayMs);
    });
  }

  async flush(timeoutMs = 5000): Promise<boolean> {
    const pending = [this.backfillPending, this.livePending].filter((value): value is Promise<void> => value !== null);
    if (pending.length === 0) return true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all(pending).then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
