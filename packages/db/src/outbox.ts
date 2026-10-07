import { and, asc, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { outbox } from "./schema.js";

/*
 * Outbox relay side. This module is the only place that claims, marks and
 * purges outbox rows. Inserts happen in holds.ts, in the same transaction as
 * the state change they describe.
 */

export type OutboxRow = typeof outbox.$inferSelect;

export const MAX_BACKOFF_SECONDS = 30;

export interface ClaimResult {
  claimed: number;
  published: number;
  failed: number;
}

/** Delay before the next attempt: 1, 2, 4, 8, 16 s, then capped at 30 s. */
export const backoffSeconds = (attempts: number): number =>
  Math.min(MAX_BACKOFF_SECONDS, 2 ** Math.max(0, attempts - 1));

/** A short machine code for last_error. Never the message text. */
const errorCode = (e: unknown): string => {
  const candidates: unknown[] =
    typeof e === "object" && e !== null
      ? [(e as { code?: unknown }).code, (e as { name?: unknown }).name]
      : [];
  for (const c of candidates) {
    if (typeof c === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(c)) return c;
  }
  return "handler_error";
};

/**
 * Claims up to `limit` due, unpublished rows in id order inside one
 * transaction (FOR UPDATE SKIP LOCKED, so a second relay never gets the same
 * row) and calls `handle` for each. A row whose handler resolves is marked
 * published. A row whose handler throws gets attempts + 1, an exponential
 * backoff capped at 30 s and a short error code; it is never dropped and the
 * remaining rows are still handled.
 */
export async function claimDue(
  db: Db,
  limit: number,
  handle: (row: OutboxRow) => Promise<void>,
): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(outbox)
      .where(and(isNull(outbox.publishedAt), lte(outbox.nextAttemptAt, sql`now()`)))
      .orderBy(asc(outbox.id))
      .limit(limit)
      .for("update", { skipLocked: true });

    let published = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await handle(row);
      } catch (e) {
        failed += 1;
        const attempts = row.attempts + 1;
        await tx
          .update(outbox)
          .set({
            attempts,
            nextAttemptAt: sql`now() + make_interval(secs => ${backoffSeconds(attempts)})`,
            lastError: errorCode(e),
          })
          .where(sql`${outbox.id} = ${row.id}`);
        continue;
      }
      published += 1;
      await tx
        .update(outbox)
        .set({ publishedAt: sql`now()`, lastError: null })
        .where(sql`${outbox.id} = ${row.id}`);
    }
    return { claimed: rows.length, published, failed };
  });
}

/** Deletes published rows older than `olderThanDays` (H-7). Returns the count. */
export async function purgePublished(db: Db, olderThanDays: number): Promise<number> {
  const rows = await db
    .delete(outbox)
    .where(sql`${outbox.publishedAt} < now() - make_interval(days => ${olderThanDays})`)
    .returning({ id: outbox.id });
  return rows.length;
}
