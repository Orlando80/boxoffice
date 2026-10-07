import { extendHold, releaseHold } from "@boxoffice/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHoldsStack, type HoldsStack } from "./support/holds-stack.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sleepUntil = (t: number): Promise<void> => sleep(Math.max(0, t - Date.now()));

async function until<T>(
  fn: () => Promise<T | undefined | false>,
  timeoutMs: number,
  stepMs = 100,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms`);
    await sleep(stepMs);
  }
}

interface HoldRow {
  status: string;
  expires_at: Date;
  ended_at: Date | null;
}
interface OutboxRowT {
  id: string;
  type: string;
  published_at: Date | null;
  attempts: number;
  last_error: string | null;
}

const holdRow = async (s: HoldsStack, id: string): Promise<HoldRow> =>
  (await s.sql<HoldRow[]>`select status, to_char(expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expires_at, to_char(ended_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ended_at from hold where id = ${id}`)
    .map((r) => ({ ...r, expires_at: new Date(r.expires_at as unknown as string), ended_at: r.ended_at === null ? null : new Date(r.ended_at as unknown as string) }))[0]!;
const outboxFor = (s: HoldsStack, id: string): Promise<OutboxRowT[]> =>
  s.sql<
    OutboxRowT[]
  >`select id::text, type, to_char(published_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as published_at, attempts, last_error from outbox where aggregate_id = ${id} order by id`.then((rows) =>
    rows.map((r) => ({ ...r, published_at: r.published_at === null ? null : new Date(r.published_at as unknown as string) })),
  );
const countType = async (s: HoldsStack, id: string, type: string): Promise<number> =>
  (await outboxFor(s, id)).filter((r) => r.type === type).length;

const workflowStatus = async (s: HoldsStack, holdId: string): Promise<string | undefined> => {
  try {
    return (await s.client.workflow.getHandle(`hold-${holdId}`).describe()).status.name;
  } catch {
    return undefined;
  }
};

function expiredLines(s: HoldsStack, holdId: string): Record<string, unknown>[] {
  return s.logLines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((o) => o.event === "hold.expired" && o.holdId === holdId);
}

function expectNoToken(s: HoldsStack, tokens: string[]): void {
  for (const line of [...s.logLines, ...s.relayLogs]) {
    for (const t of tokens) expect(line).not.toContain(t);
  }
}

describe("holds workflow and relay (Postgres + Temporal)", () => {
  let s: HoldsStack;
  const tokens: string[] = [];
  beforeAll(async () => {
    s = await startHoldsStack({ relay: "real", intervalMs: 100 });
  }, 240_000);
  afterAll(async () => {
    await s?.stop();
  }, 60_000);

  it("AC 16: a 2 s hold expires within 7 s with one hold.expired row and one lag line; seat is holdable again", async () => {
    const perf = await s.createPerformance();
    const t0 = Date.now();
    const h = await s.createHoldFor(perf, { lengthSeconds: 2 });
    tokens.push(h.token);

    await until(
      async () => (await holdRow(s, h.holdId)).status === "expired",
      7000 - (Date.now() - t0),
      50,
    );
    expect(Date.now() - t0).toBeLessThanOrEqual(7000);

    const row = await holdRow(s, h.holdId);
    expect(row.ended_at).not.toBeNull();
    expect(row.ended_at!.getTime()).toBeGreaterThanOrEqual(row.expires_at.getTime());

    expect(await countType(s, h.holdId, "hold.expired")).toBe(1);
    expect(await countType(s, h.holdId, "hold.created")).toBe(1);

    const lines = expiredLines(s, h.holdId);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(Object.keys(line).sort()).toEqual(["event", "holdId", "lag_ms", "venueId"]);
    expect(line.venueId).toBe(perf.venueId);
    expect(typeof line.lag_ms).toBe("number");
    expect(Number.isFinite(line.lag_ms)).toBe(true);
    expect(line.lag_ms as number).toBeGreaterThanOrEqual(0);
    expect(line.lag_ms as number).toBeLessThanOrEqual(5000); // H-7 target
    expect(line.lag_ms).toBe(row.ended_at!.getTime() - row.expires_at.getTime());

    // The seat is available again.
    const again = await s.createHoldFor(perf, { seatIds: h.seatIds, lengthSeconds: 60 });
    tokens.push(again.token);
    expect(again.holdId).not.toBe(h.holdId);

    // The workflow ended on its own once the hold ended.
    await until(async () => (await workflowStatus(s, h.holdId)) === "COMPLETED", 5000);
    // The relay publishes hold.expired as a no-op event.
    await until(
      async () => (await outboxFor(s, h.holdId)).every((r) => r.published_at !== null),
      5000,
    );
    expectNoToken(s, tokens);
  });

  it("AC 17: an extended hold is still active at its original expiry and expires after the new one", async () => {
    const perf = await s.createPerformance();
    const h = await s.createHoldFor(perf, { lengthSeconds: 2 });
    tokens.push(h.token);
    const original = h.expiresAt.getTime();

    // Extend ~1.2 s in; new expiry = db now + 2 s, about 1.2 s after the original.
    await sleepUntil(original - 800);
    const ext = await extendHold(s.db, perf.venueId, h.holdId, h.token, { lengthSeconds: 2 });
    expect(ext).not.toBeNull();
    expect(ext!.ok).toBe(true);
    const newExpiry = (await holdRow(s, h.holdId)).expires_at.getTime();
    expect(newExpiry).toBeGreaterThan(original + 500);

    // 400 ms after the original time the timer has fired (or is about to) but the hold must be untouched.
    await sleepUntil(original + 400);
    expect(Date.now()).toBeLessThan(newExpiry - 200); // test-timing guard
    const mid = await holdRow(s, h.holdId);
    expect(mid.status).toBe("active");
    expect(mid.ended_at).toBeNull();
    expect(await countType(s, h.holdId, "hold.expired")).toBe(0);
    expect(await workflowStatus(s, h.holdId)).toBe("RUNNING");

    // It expires after the new time.
    await until(async () => (await holdRow(s, h.holdId)).status === "expired", 7000, 50);
    const end = await holdRow(s, h.holdId);
    expect(end.ended_at!.getTime()).toBeGreaterThanOrEqual(newExpiry);
    expect(await countType(s, h.holdId, "hold.expired")).toBe(1);
    expect(await countType(s, h.holdId, "hold.extended")).toBe(1);

    const lines = expiredLines(s, h.holdId);
    expect(lines).toHaveLength(1);
    // lag is measured against the extended expiry, not the original one.
    expect(lines[0]!.lag_ms).toBe(end.ended_at!.getTime() - newExpiry);
    expect(lines[0]!.lag_ms as number).toBeLessThan(5000);
    await until(async () => (await workflowStatus(s, h.holdId)) === "COMPLETED", 5000);
    expectNoToken(s, tokens);
  });

  it("AC 18: a released hold's workflow completes within 5 s of release, without an expiry", async () => {
    const perf = await s.createPerformance();
    const h = await s.createHoldFor(perf, { lengthSeconds: 120 });
    tokens.push(h.token);
    await until(async () => (await workflowStatus(s, h.holdId)) === "RUNNING", 10_000);

    const t0 = Date.now();
    const view = await releaseHold(s.db, perf.venueId, h.holdId, h.token);
    expect(view).not.toBeNull();
    await until(
      async () => (await workflowStatus(s, h.holdId)) === "COMPLETED",
      5000 - (Date.now() - t0),
      50,
    );
    expect(Date.now() - t0).toBeLessThanOrEqual(5000);

    const row = await holdRow(s, h.holdId);
    expect(row.status).toBe("released");
    expect(await countType(s, h.holdId, "hold.released")).toBe(1);
    expect(await countType(s, h.holdId, "hold.expired")).toBe(0);
    expect(expiredLines(s, h.holdId)).toHaveLength(0);
    await until(
      async () => (await outboxFor(s, h.holdId)).every((r) => r.published_at !== null),
      5000,
    );

    // Releasing again (workflow completed) is harmless: the signal for the second row path is not needed,
    // but a stray hold.released redelivery to a completed workflow must count as delivered.
    await s.sql`update outbox set published_at = null, next_attempt_at = now()
                where aggregate_id = ${h.holdId} and type = 'hold.released'`;
    await until(async () => {
      const r = (await outboxFor(s, h.holdId)).find((x) => x.type === "hold.released")!;
      return r.published_at !== null && r.attempts === 0 ? true : undefined;
    }, 5000);
    expectNoToken(s, tokens);
  });

  it("AC 19: delivering the same hold.created twice starts one workflow and both deliveries are published", async () => {
    const perf = await s.createPerformance();
    const h = await s.createHoldFor(perf, { lengthSeconds: 120 });
    tokens.push(h.token);
    const created = async (): Promise<OutboxRowT> =>
      (await outboxFor(s, h.holdId)).find((r) => r.type === "hold.created")!;

    const first = await until(async () => {
      const r = await created();
      return r.published_at ?? undefined;
    }, 10_000);
    const handle = s.client.workflow.getHandle(`hold-${h.holdId}`);
    const d1 = await handle.describe();
    expect(d1.status.name).toBe("RUNNING");

    // Redeliver the very same row.
    await sleep(50);
    await s.sql`update outbox set published_at = null, next_attempt_at = now()
                where aggregate_id = ${h.holdId} and type = 'hold.created'`;
    const second = await until(async () => {
      const r = await created();
      return r.published_at ?? undefined;
    }, 10_000);
    expect(second.getTime()).toBeGreaterThan(first.getTime());
    expect((await created()).attempts).toBe(0);

    const d2 = await s.client.workflow.getHandle(`hold-${h.holdId}`).describe();
    expect(d2.runId).toBe(d1.runId);
    expect(d2.status.name).toBe("RUNNING");

    // Also race two explicit ticks on a third redelivery: still one run.
    await s.sql`update outbox set published_at = null, next_attempt_at = now()
                where aggregate_id = ${h.holdId} and type = 'hold.created'`;
    await Promise.all([s.relay()!.tick(), s.relay()!.tick()]);
    await until(async () => ((await created()).published_at !== null ? true : undefined), 10_000);

    const executions: string[] = [];
    for await (const w of s.client.workflow.list({ query: `WorkflowId = "hold-${h.holdId}"` })) {
      executions.push(w.runId);
    }
    // Visibility is eventually consistent; whatever it reports must be at most the one run.
    expect(new Set(executions).size).toBeLessThanOrEqual(1);
    expect((await s.client.workflow.getHandle(`hold-${h.holdId}`).describe()).runId).toBe(d1.runId);
    expect(s.relayLogs).toEqual([]);

    await releaseHold(s.db, perf.venueId, h.holdId, h.token);
    expectNoToken(s, tokens);
  });
});

describe("AC 20: Temporal unreachable", () => {
  let s: HoldsStack;
  const tokens: string[] = [];
  beforeAll(async () => {
    s = await startHoldsStack({ relay: "none", intervalMs: 100 });
  }, 240_000);
  afterAll(async () => {
    await s?.stop();
  }, 60_000);

  it("rows stay unpublished with attempts rising, lazy expiry keeps the seat holdable, then the real target starts the workflows", async () => {
    const perf = await s.createPerformance();
    await s.useUnreachableRelay();

    // A: its seat will be re-held by a new hold after expiry (lazy expiry).
    const a = await s.createHoldFor(perf, { lengthSeconds: 2 });
    // B: left alone; after Temporal returns its workflow must end it.
    const b = await s.createHoldFor(perf, { lengthSeconds: 2 });
    tokens.push(a.token, b.token);

    await until(async () => {
      const r = (await outboxFor(s, a.holdId))[0]!;
      return r.attempts >= 2 ? r : undefined;
    }, 20_000);
    const rowA = (await outboxFor(s, a.holdId))[0]!;
    expect(rowA.type).toBe("hold.created");
    expect(rowA.published_at).toBeNull();
    expect(rowA.last_error).not.toBeNull();
    expect(rowA.last_error!).toMatch(/^[A-Za-z0-9_.-]{1,40}$/); // short code, no message text
    expect(s.relayLogs.join("\n")).not.toContain("127.0.0.1");

    // Past expiry, with nothing having run the timer: the DB still says active, yet the seat is free.
    await sleepUntil(Math.max(a.expiresAt.getTime(), b.expiresAt.getTime()) + 300);
    expect((await holdRow(s, a.holdId)).status).toBe("active");
    const reheld = await s.createHoldFor(perf, { seatIds: a.seatIds, lengthSeconds: 120 });
    tokens.push(reheld.token);
    expect((await holdRow(s, a.holdId)).status).toBe("expired"); // lazily ended by the new create
    expect(
      (await outboxFor(s, a.holdId)).find((r) => r.type === "hold.created")!.published_at,
    ).toBeNull();
    expect(await workflowStatus(s, a.holdId)).toBeUndefined(); // no workflow was ever started

    // Temporal is back.
    await s.useRealRelay();
    await until(async () => {
      const rows = await outboxFor(s, b.holdId);
      return rows.find((r) => r.type === "hold.created")!.published_at !== null ? true : undefined;
    }, 45_000);

    // B's workflow ends B, with one hold.expired row and one lag line.
    await until(async () => (await holdRow(s, b.holdId)).status === "expired", 15_000, 100);
    await until(async () => (await workflowStatus(s, b.holdId)) === "COMPLETED", 10_000);
    expect(await countType(s, b.holdId, "hold.expired")).toBe(1);
    expect(expiredLines(s, b.holdId)).toHaveLength(1);

    // A was already ended lazily: its workflow starts, sees it, and ends without a second hold.expired.
    await until(async () => (await workflowStatus(s, a.holdId)) === "COMPLETED", 20_000);
    expect(await countType(s, a.holdId, "hold.expired")).toBe(1);
    expect(expiredLines(s, a.holdId)).toHaveLength(0);

    // Everything drains.
    await until(
      async () =>
        (
          await s.sql<
            { n: number }[]
          >`select count(*)::int as n from outbox where published_at is null`
        )[0]!.n === 0
          ? true
          : undefined,
      20_000,
    );
    expectNoToken(s, tokens);
  });
});
