import { createHash, randomBytes } from "node:crypto";
import {
  checkExtension,
  err,
  HOLD_LENGTH_SECONDS,
  MAX_EXTENSIONS,
  ok,
  validateHoldRequest,
  type AccessFeature,
  type GaSectionFact,
  type HoldFacts,
  type HoldRequest,
  type HoldStatus,
  type HoldViolation,
  type Result,
  type SeatFact,
  type SeatRole,
} from "@boxoffice/domain";
import { and, asc, eq, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  companionLink,
  gaInventory,
  hold,
  holdAccessNeed,
  holdGa,
  holdSeat,
  outbox,
  performance,
  seat,
  seatAccessFeature,
  section,
} from "./schema.js";

/*
 * Sole writer of hold, hold_seat, hold_ga, ga_inventory and hold_access_need,
 * and the sole inserter of outbox rows (the relay in outbox.ts claims, marks
 * and purges them). Every function takes `db` first and `venueId` second, and
 * scopes by venue in SQL. All times come from the database clock (now()).
 * Nothing here returns or logs a token (except createHold's one result) or an
 * access need.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type OutboxEventType = "hold.created" | "hold.extended" | "hold.released" | "hold.expired";

export interface HoldCreated {
  holdId: string;
  /** Returned once, never stored. Only sha256(token) is persisted. */
  token: string;
  expiresAt: Date;
  extensionsRemaining: number;
}

export type CreateHoldFailure =
  | { code: "seats_unavailable"; seatIds: string[]; sectionIds: string[] }
  | { code: "invalid_hold"; rule: HoldViolation["rule"]; violations: HoldViolation[] }
  | { code: "performance_not_found" };

export type CreateHoldResult = Result<HoldCreated, CreateHoldFailure>;

export interface HoldView {
  holdId: string;
  performanceId: string;
  /** "expired" is reported for an active hold past expires_at (H-8). */
  status: HoldStatus;
  expiresAt: Date;
  extensionsRemaining: number;
  seats: { seatId: string; role: SeatRole }[];
  ga: { sectionId: string; quantity: number }[];
}

/** null = no such hold, or wrong token. */
export type ExtendHoldResult = Result<HoldView, "extension_limit" | "hold_ended"> | null;

export type ExpireHoldResult =
  | { ended: true; lagMs: number }
  | { ended: false; expiresAt: Date }
  | { ended: false; expiresAt: null; reason: "already_ended" | "not_found" };

/**
 * TEST-ONLY seam. Not for production callers: lets a test throw after the
 * hold rows are written and before the outbox insert, to prove the whole
 * transaction rolls back (AC 6).
 */
export interface CreateHoldHooks {
  beforeOutboxInsert?: () => void | Promise<void>;
}

// ---------- helpers ----------

const hashToken = (token: string): Buffer => createHash("sha256").update(token).digest();
const sortIds = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

const errCodes = (e: unknown): string[] => {
  const out: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 4 && typeof cur === "object" && cur !== null; i += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") out.push(code);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
};

/** Runs `fn`; retries the whole thing once on deadlock (40P01) or serialization failure (40001). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (errCodes(e).some((c) => c === "40P01" || c === "40001")) return fn();
    throw e;
  }
}

const dbNow = async (tx: Tx): Promise<Date> => {
  const rows = await tx.execute<{ now: string }>(
    sql`select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`,
  );
  return new Date(rows[0]!.now);
};

/** Thrown inside the create transaction to roll it back with a typed failure. */
class Abort extends Error {
  constructor(readonly failure: CreateHoldFailure) {
    super("abort");
  }
}

async function insertOutbox(
  tx: Tx,
  type: OutboxEventType,
  h: { id: string; venueId: string; performanceId: string },
  times: { expiresAt?: Date; endedAt?: Date | null },
): Promise<void> {
  // IDs and times only. Never a token or an access need.
  const payload: Record<string, string> = {
    holdId: h.id,
    venueId: h.venueId,
    performanceId: h.performanceId,
  };
  if (times.expiresAt) payload.expiresAt = times.expiresAt.toISOString();
  if (times.endedAt) payload.endedAt = times.endedAt.toISOString();
  await tx.insert(outbox).values({ venueId: h.venueId, type, aggregateId: h.id, payload });
}

/**
 * The one place a hold ends (release, expiry, lazy expiry). Conditional on
 * status = 'active' (plus `extra`), so only one caller wins a race. Returns
 * null if this call did not end the hold.
 */
async function endHold(
  tx: Tx,
  venueId: string,
  holdId: string,
  status: "released" | "expired",
  extra?: SQL,
): Promise<{ performanceId: string; expiresAt: Date; endedAt: Date } | null> {
  const [h] = await tx
    .update(hold)
    .set({ status, endedAt: sql`now()` })
    .where(
      and(
        eq(hold.venueId, venueId),
        eq(hold.id, holdId),
        eq(hold.status, "active"),
        ...(extra ? [extra] : []),
      ),
    )
    .returning({
      performanceId: hold.performanceId,
      expiresAt: hold.expiresAt,
      endedAt: hold.endedAt,
    });
  if (!h || !h.endedAt) return null;

  await tx
    .update(holdSeat)
    .set({ endedAt: sql`now()` })
    .where(
      and(eq(holdSeat.venueId, venueId), eq(holdSeat.holdId, holdId), isNull(holdSeat.endedAt)),
    );

  const lines = await tx
    .update(holdGa)
    .set({ endedAt: sql`now()` })
    .where(and(eq(holdGa.venueId, venueId), eq(holdGa.holdId, holdId), isNull(holdGa.endedAt)))
    .returning({ sectionId: holdGa.sectionId, quantity: holdGa.quantity });
  lines.sort((a, b) => (a.sectionId < b.sectionId ? -1 : 1));
  for (const l of lines) {
    await tx
      .update(gaInventory)
      .set({ held: sql`${gaInventory.held} - ${l.quantity}` })
      .where(
        and(
          eq(gaInventory.venueId, venueId),
          eq(gaInventory.performanceId, h.performanceId),
          eq(gaInventory.sectionId, l.sectionId),
        ),
      );
  }

  await tx
    .delete(holdAccessNeed)
    .where(and(eq(holdAccessNeed.venueId, venueId), eq(holdAccessNeed.holdId, holdId)));

  await insertOutbox(
    tx,
    status === "released" ? "hold.released" : "hold.expired",
    { id: holdId, venueId, performanceId: h.performanceId },
    { expiresAt: h.expiresAt, endedAt: h.endedAt },
  );
  return { performanceId: h.performanceId, expiresAt: h.expiresAt, endedAt: h.endedAt };
}

async function loadView(tx: Tx, row: typeof hold.$inferSelect, now: Date): Promise<HoldView> {
  const seats = await tx
    .select({ seatId: holdSeat.seatId, role: holdSeat.role })
    .from(holdSeat)
    .where(and(eq(holdSeat.venueId, row.venueId), eq(holdSeat.holdId, row.id)))
    .orderBy(asc(holdSeat.seatId));
  const ga = await tx
    .select({ sectionId: holdGa.sectionId, quantity: holdGa.quantity })
    .from(holdGa)
    .where(and(eq(holdGa.venueId, row.venueId), eq(holdGa.holdId, row.id)))
    .orderBy(asc(holdGa.sectionId));
  const overdue = row.status === "active" && row.expiresAt.getTime() <= now.getTime();
  return {
    holdId: row.id,
    performanceId: row.performanceId,
    status: overdue ? "expired" : row.status,
    expiresAt: row.expiresAt,
    extensionsRemaining: MAX_EXTENSIONS - row.extensionsUsed,
    seats,
    ga,
  };
}

// ---------- createHold ----------

export async function createHold(
  db: Db,
  venueId: string,
  performanceId: string,
  request: HoldRequest,
  opts: { lengthSeconds: number },
  hooks: CreateHoldHooks = {},
): Promise<CreateHoldResult> {
  return withRetry(async () => {
    try {
      return await db.transaction((tx) =>
        createInTx(tx, venueId, performanceId, request, opts.lengthSeconds, hooks),
      );
    } catch (e) {
      if (e instanceof Abort) return err(e.failure);
      throw e;
    }
  });
}

async function createInTx(
  tx: Tx,
  venueId: string,
  performanceId: string,
  request: HoldRequest,
  lengthSeconds: number,
  hooks: CreateHoldHooks,
): Promise<CreateHoldResult> {
  // 1. Facts (venue-scoped; foreign ids simply have no fact), then validate.
  const [perf] = await tx
    .select({ layoutId: performance.layoutId, startsAt: performance.startsAt })
    .from(performance)
    .where(and(eq(performance.venueId, venueId), eq(performance.id, performanceId)));
  if (!perf) return err({ code: "performance_not_found" });

  const seatIds = sortIds(request.seats.map((s) => s.seatId));
  const sectionIds = sortIds(request.ga.map((g) => g.sectionId));

  const seats = new Map<string, SeatFact>();
  if (seatIds.length > 0) {
    const rows = await tx
      .select({ id: seat.id, kind: section.kind, layoutId: section.layoutId })
      .from(seat)
      .innerJoin(section, and(eq(section.venueId, seat.venueId), eq(section.id, seat.sectionId)))
      .where(and(eq(seat.venueId, venueId), inArray(seat.id, seatIds)));
    const features = await tx
      .select({ seatId: seatAccessFeature.seatId, feature: seatAccessFeature.feature })
      .from(seatAccessFeature)
      .where(
        and(eq(seatAccessFeature.venueId, venueId), inArray(seatAccessFeature.seatId, seatIds)),
      );
    const links = await tx
      .select({ access: companionLink.accessSeatId, companion: companionLink.companionSeatId })
      .from(companionLink)
      .where(
        and(eq(companionLink.venueId, venueId), inArray(companionLink.companionSeatId, seatIds)),
      );
    for (const r of rows) {
      seats.set(r.id, {
        seatId: r.id,
        sectionKind: r.kind,
        layoutId: r.layoutId,
        accessFeatures: features.filter((f) => f.seatId === r.id).map((f) => f.feature),
        companionOf: links.find((l) => l.companion === r.id)?.access ?? null,
      });
    }
  }
  const sections = new Map<string, GaSectionFact>();
  const capacity = new Map<string, number>();
  if (sectionIds.length > 0) {
    const rows = await tx
      .select({
        id: section.id,
        kind: section.kind,
        layoutId: section.layoutId,
        capacity: section.gaCapacity,
      })
      .from(section)
      .where(and(eq(section.venueId, venueId), inArray(section.id, sectionIds)));
    for (const r of rows) {
      sections.set(r.id, { sectionId: r.id, sectionKind: r.kind, layoutId: r.layoutId });
      if (r.capacity !== null) capacity.set(r.id, r.capacity);
    }
  }
  const facts: HoldFacts = {
    performanceLayoutId: perf.layoutId,
    performanceStartsAt: perf.startsAt,
    seats,
    sections,
  };
  const validated = validateHoldRequest(request, facts, await dbNow(tx));
  if (!validated.ok) {
    return err({
      code: "invalid_hold",
      rule: validated.error[0]!.rule,
      violations: validated.error,
    });
  }

  // 2. Lazily expire due holds that touch the requested seats or GA sections.
  const due = new Set<string>();
  const isDue = and(eq(hold.status, "active"), lte(hold.expiresAt, sql`now()`));
  if (seatIds.length > 0) {
    const rows = await tx
      .selectDistinct({ id: holdSeat.holdId })
      .from(holdSeat)
      .innerJoin(hold, and(eq(hold.venueId, holdSeat.venueId), eq(hold.id, holdSeat.holdId)))
      .where(
        and(
          eq(holdSeat.venueId, venueId),
          eq(holdSeat.performanceId, performanceId),
          inArray(holdSeat.seatId, seatIds),
          isNull(holdSeat.endedAt),
          isDue,
        ),
      );
    for (const r of rows) due.add(r.id);
  }
  if (sectionIds.length > 0) {
    const rows = await tx
      .selectDistinct({ id: holdGa.holdId })
      .from(holdGa)
      .innerJoin(hold, and(eq(hold.venueId, holdGa.venueId), eq(hold.id, holdGa.holdId)))
      .where(
        and(
          eq(holdGa.venueId, venueId),
          eq(holdGa.performanceId, performanceId),
          inArray(holdGa.sectionId, sectionIds),
          isNull(holdGa.endedAt),
          isDue,
        ),
      );
    for (const r of rows) due.add(r.id);
  }
  for (const id of sortIds(due)) {
    await endHold(tx, venueId, id, "expired", sql`${hold.expiresAt} <= now()`);
  }

  // 3. GA inventory: upsert from capacity, then conditional increments in sorted section order.
  const gaLines = [...request.ga].sort((a, b) => (a.sectionId < b.sectionId ? -1 : 1));
  const shortSections: string[] = [];
  if (gaLines.length > 0) {
    await tx
      .insert(gaInventory)
      .values(
        gaLines.map((g) => ({
          venueId,
          performanceId,
          sectionId: g.sectionId,
          capacity: capacity.get(g.sectionId)!,
        })),
      )
      .onConflictDoNothing();
    for (const g of gaLines) {
      const updated = await tx
        .update(gaInventory)
        .set({ held: sql`${gaInventory.held} + ${g.quantity}` })
        .where(
          and(
            eq(gaInventory.venueId, venueId),
            eq(gaInventory.performanceId, performanceId),
            eq(gaInventory.sectionId, g.sectionId),
            sql`${gaInventory.held} + ${g.quantity} <= ${gaInventory.capacity}`,
          ),
        )
        .returning({ sectionId: gaInventory.sectionId });
      if (updated.length === 0) shortSections.push(g.sectionId);
    }
  }

  const takenSeats = async (): Promise<string[]> => {
    if (seatIds.length === 0) return [];
    const rows = await tx
      .select({ seatId: holdSeat.seatId })
      .from(holdSeat)
      .where(
        and(
          eq(holdSeat.performanceId, performanceId),
          inArray(holdSeat.seatId, seatIds),
          isNull(holdSeat.endedAt),
        ),
      );
    return sortIds(rows.map((r) => r.seatId));
  };
  if (shortSections.length > 0) {
    throw new Abort({
      code: "seats_unavailable",
      seatIds: await takenSeats(),
      sectionIds: shortSections,
    });
  }

  // 4. Hold, then lines (GA, then seats in sorted order).
  const token = randomBytes(32).toString("base64url");
  const [created] = await tx
    .insert(hold)
    .values({
      venueId,
      performanceId,
      tokenHash: hashToken(token),
      status: "active",
      expiresAt: sql`now() + make_interval(secs => ${lengthSeconds})`,
    })
    .returning({ id: hold.id, expiresAt: hold.expiresAt });
  const holdId = created!.id;

  if (gaLines.length > 0) {
    await tx.insert(holdGa).values(
      gaLines.map((g) => ({
        venueId,
        holdId,
        performanceId,
        sectionId: g.sectionId,
        quantity: g.quantity,
      })),
    );
  }
  const seatLines = [...request.seats].sort((a, b) => (a.seatId < b.seatId ? -1 : 1));
  if (seatLines.length > 0) {
    try {
      // Savepoint, so a 23505 leaves the transaction usable to report conflicts.
      await tx.transaction((sp) =>
        sp.insert(holdSeat).values(
          seatLines.map((s) => ({
            venueId,
            holdId,
            performanceId,
            seatId: s.seatId,
            role: s.role,
          })),
        ),
      );
    } catch (e) {
      if (errCodes(e).includes("23505")) {
        throw new Abort({
          code: "seats_unavailable",
          seatIds: await takenSeats(),
          sectionIds: [],
        });
      }
      throw e;
    }
  }

  // 5. Access needs (own table) and the outbox row.
  const needs = seatLines.filter((s) => s.role === "access");
  if (needs.length > 0) {
    await tx.insert(holdAccessNeed).values(
      needs.map((s) => ({
        venueId,
        holdId,
        seatId: s.seatId,
        need: s.accessNeed as AccessFeature,
      })),
    );
  }
  await hooks.beforeOutboxInsert?.();
  await insertOutbox(
    tx,
    "hold.created",
    { id: holdId, venueId, performanceId },
    { expiresAt: created!.expiresAt },
  );

  return ok({
    holdId,
    token,
    expiresAt: created!.expiresAt,
    extensionsRemaining: MAX_EXTENSIONS,
  });
}

// ---------- token-scoped operations ----------

const byToken = (venueId: string, holdId: string, token: string) =>
  and(eq(hold.venueId, venueId), eq(hold.id, holdId), eq(hold.tokenHash, hashToken(token)));

export async function getHold(
  db: Db,
  venueId: string,
  holdId: string,
  token: string,
): Promise<HoldView | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(hold)
      .where(byToken(venueId, holdId, token));
    return row ? loadView(tx, row, await dbNow(tx)) : null;
  });
}

/**
 * `lengthSeconds` defaults to HOLD_LENGTH_SECONDS; the API passes the same
 * value it gave createHold, so tests with short holds extend by a short time.
 */
export async function extendHold(
  db: Db,
  venueId: string,
  holdId: string,
  token: string,
  opts: { lengthSeconds?: number } = {},
): Promise<ExtendHoldResult> {
  const lengthSeconds = opts.lengthSeconds ?? HOLD_LENGTH_SECONDS;
  return withRetry(() =>
    db.transaction(async (tx): Promise<ExtendHoldResult> => {
      const [row] = await tx
        .select()
        .from(hold)
        .where(byToken(venueId, holdId, token))
        .for("update");
      if (!row) return null;
      const now = await dbNow(tx);
      if (row.status !== "active" || row.expiresAt.getTime() <= now.getTime()) {
        return err("hold_ended");
      }
      const check = checkExtension(row.extensionsUsed);
      if (!check.ok) return err("extension_limit");

      const [updated] = await tx
        .update(hold)
        .set({
          expiresAt: sql`now() + make_interval(secs => ${lengthSeconds})`,
          extensionsUsed: sql`${hold.extensionsUsed} + 1`,
        })
        .where(
          and(
            byToken(venueId, holdId, token),
            eq(hold.status, "active"),
            sql`${hold.expiresAt} > now()`,
          ),
        )
        .returning();
      if (!updated) return err("hold_ended");
      await insertOutbox(
        tx,
        "hold.extended",
        { id: holdId, venueId, performanceId: updated.performanceId },
        { expiresAt: updated.expiresAt },
      );
      return ok(await loadView(tx, updated, now));
    }),
  );
}

/**
 * Idempotent. Releasing an already released or expired hold returns its
 * current view (the spec is silent on hold_ended for release; AC 12 only asks
 * for idempotence). An active hold that is already past expires_at is ended
 * as expired, not released.
 */
export async function releaseHold(
  db: Db,
  venueId: string,
  holdId: string,
  token: string,
): Promise<HoldView | null> {
  return withRetry(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(hold)
        .where(byToken(venueId, holdId, token))
        .for("update");
      if (!row) return null;
      if (row.status === "active") {
        const now = await dbNow(tx);
        const overdue = row.expiresAt.getTime() <= now.getTime();
        await endHold(tx, venueId, holdId, overdue ? "expired" : "released");
      }
      const [fresh] = await tx
        .select()
        .from(hold)
        .where(byToken(venueId, holdId, token));
      return loadView(tx, fresh!, await dbNow(tx));
    }),
  );
}

// ---------- worker operations ----------

/** Raw stored status (not the overdue-adjusted one): the workflow stops unless it is "active". */
export async function getHoldExpiry(
  db: Db,
  venueId: string,
  holdId: string,
): Promise<{ status: HoldStatus; expiresAt: Date } | null> {
  const [row] = await db
    .select({ status: hold.status, expiresAt: hold.expiresAt })
    .from(hold)
    .where(and(eq(hold.venueId, venueId), eq(hold.id, holdId)));
  return row ?? null;
}

/**
 * Ends the hold only if active and due. { ended: false, expiresAt: Date }
 * means it was extended: sleep again. expiresAt null means stop (already
 * ended, or no such hold).
 */
export async function expireHoldIfDue(
  db: Db,
  venueId: string,
  holdId: string,
): Promise<ExpireHoldResult> {
  return withRetry(() =>
    db.transaction(async (tx): Promise<ExpireHoldResult> => {
      const ended = await endHold(tx, venueId, holdId, "expired", sql`${hold.expiresAt} <= now()`);
      if (ended) return { ended: true, lagMs: ended.endedAt.getTime() - ended.expiresAt.getTime() };
      const [row] = await tx
        .select({ status: hold.status, expiresAt: hold.expiresAt })
        .from(hold)
        .where(and(eq(hold.venueId, venueId), eq(hold.id, holdId)));
      if (!row) return { ended: false, expiresAt: null, reason: "not_found" };
      if (row.status !== "active")
        return { ended: false, expiresAt: null, reason: "already_ended" };
      return { ended: false, expiresAt: row.expiresAt };
    }),
  );
}

/** Deletes ended holds (and, by cascade, their lines) older than the given age (H-7). Returns the count. */
export async function purgeEndedHolds(db: Db, olderThanDays: number): Promise<number> {
  const rows = await db
    .delete(hold)
    .where(sql`${hold.endedAt} < now() - make_interval(days => ${olderThanDays})`)
    .returning({ id: hold.id });
  return rows.length;
}
