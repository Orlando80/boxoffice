import type { Db, OutboxRow } from "@boxoffice/db";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowNotFoundError,
  type Client,
} from "@temporalio/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The seam: claimDue is replaced by a faithful in-memory copy of its contract
// (handler resolves -> published, handler throws -> failed, others still run).
// The real SQL is covered by packages/db tests and holds.int.test.ts.
const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  claimDue: undefined as
    undefined | ((db: unknown, limit: number, h: (r: never) => Promise<void>) => Promise<unknown>),
}));
const purgePublished = vi.hoisted(() => vi.fn());
const purgeEndedHolds = vi.hoisted(() => vi.fn());
const claimDueSpy = vi.hoisted(() => vi.fn());

vi.mock("@boxoffice/db", () => ({
  claimDue: claimDueSpy,
  purgePublished,
  purgeEndedHolds,
}));

import { startRelay, type Relay } from "../src/relay.js";

const db = { tag: "db" } as unknown as Db;
const HOLD = "11111111-1111-4111-8111-111111111111";
const VENUE = "22222222-2222-4222-8222-222222222222";

const row = (type: string, id = 1, holdId = HOLD): OutboxRow =>
  ({
    id,
    type,
    venueId: VENUE,
    aggregateId: holdId,
    payload: { holdId, venueId: VENUE, performanceId: "p" },
    createdAt: new Date(),
    publishedAt: null,
    attempts: 0,
    nextAttemptAt: new Date(),
    lastError: null,
  }) as OutboxRow;

const faithfulClaimDue = async (
  _db: unknown,
  _limit: number,
  handle: (r: OutboxRow) => Promise<void>,
) => {
  let published = 0;
  let failed = 0;
  const rows = state.rows as OutboxRow[];
  for (const r of rows) {
    try {
      await handle(r);
      published += 1;
    } catch {
      failed += 1;
    }
  }
  return { claimed: rows.length, published, failed };
};

function fakeClient() {
  const signal = vi.fn(async () => undefined);
  const start = vi.fn(async () => ({}));
  const getHandle = vi.fn(() => ({ signal }));
  return {
    client: { workflow: { start, getHandle } } as unknown as Client,
    start,
    getHandle,
    signal,
  };
}

const relays: Relay[] = [];
const begin = (client: Client, o: Partial<Parameters<typeof startRelay>[0]> = {}): Relay => {
  const r = startRelay({
    db,
    client,
    taskQueue: "q",
    intervalMs: 3_600_000, // loop effectively off; tests drive tick()
    housekeepingMs: 3_600_000,
    ...o,
  });
  relays.push(r);
  return r;
};

beforeEach(() => {
  state.rows = [];
  claimDueSpy.mockReset().mockImplementation(faithfulClaimDue);
  purgePublished.mockReset().mockResolvedValue(0);
  purgeEndedHolds.mockReset().mockResolvedValue(0);
});
afterEach(async () => {
  await Promise.all(relays.splice(0).map((r) => r.stop()));
});

describe("relay handlers", () => {
  it("hold.created starts holdWorkflow with id hold-<id>, args, task queue and USE_EXISTING", async () => {
    const { client, start, signal } = fakeClient();
    state.rows = [row("hold.created")];
    const res = await begin(client).tick();
    expect(res).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("holdWorkflow", {
      taskQueue: "q",
      workflowId: `hold-${HOLD}`,
      args: [HOLD, VENUE],
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    });
    expect(signal).not.toHaveBeenCalled();
  });

  it("hold.released signals 'released' on hold-<id> and does not start", async () => {
    const { client, start, getHandle, signal } = fakeClient();
    state.rows = [row("hold.released")];
    const res = await begin(client).tick();
    expect(res.published).toBe(1);
    expect(getHandle).toHaveBeenCalledWith(`hold-${HOLD}`);
    expect(signal).toHaveBeenCalledWith("released");
    expect(start).not.toHaveBeenCalled();
  });

  it.each(["hold.extended", "hold.expired", "something.else"])(
    "%s makes no Temporal call and is published",
    async (type) => {
      const { client, start, getHandle, signal } = fakeClient();
      state.rows = [row(type)];
      const res = await begin(client).tick();
      expect(res).toEqual({ claimed: 1, published: 1, failed: 0 });
      expect(start).not.toHaveBeenCalled();
      expect(getHandle).not.toHaveBeenCalled();
      expect(signal).not.toHaveBeenCalled();
    },
  );

  it("passes the batch size to claimDue and rows are handled in the order given", async () => {
    const { client, start } = fakeClient();
    const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    state.rows = [row("hold.created", 1, a), row("hold.created", 2, b)];
    await begin(client, { batch: 7 }).tick();
    expect(claimDueSpy.mock.calls[0]![1]).toBe(7);
    expect(
      start.mock.calls.map((c) => (c as unknown as [string, { workflowId: string }])[1].workflowId),
    ).toEqual([`hold-${a}`, `hold-${b}`]);
  });
  it("default batch is 100", async () => {
    const { client } = fakeClient();
    await begin(client).tick();
    expect(claimDueSpy.mock.calls[0]![1]).toBe(100);
  });
});

describe("relay success and failure classification", () => {
  it("WorkflowExecutionAlreadyStartedError on start counts as success", async () => {
    const { client, start } = fakeClient();
    start.mockRejectedValueOnce(
      new WorkflowExecutionAlreadyStartedError("dup", `hold-${HOLD}`, "holdWorkflow"),
    );
    state.rows = [row("hold.created")];
    expect(await begin(client).tick()).toEqual({ claimed: 1, published: 1, failed: 0 });
  });

  it("WorkflowNotFoundError on signal counts as success", async () => {
    const { client, signal } = fakeClient();
    signal.mockRejectedValueOnce(new WorkflowNotFoundError("gone", `hold-${HOLD}`, undefined));
    state.rows = [row("hold.released")];
    expect(await begin(client).tick()).toEqual({ claimed: 1, published: 1, failed: 0 });
  });

  it("other errors on start propagate to claimDue so the row is failed (retried)", async () => {
    const { client, start } = fakeClient();
    start.mockRejectedValueOnce(new Error("UNAVAILABLE"));
    const seen: unknown[] = [];
    claimDueSpy.mockImplementation(
      async (_d: unknown, _l: number, handle: (r: OutboxRow) => Promise<void>) => {
        try {
          await handle(row("hold.created"));
        } catch (e) {
          seen.push(e);
        }
        return { claimed: 1, published: 0, failed: 1 };
      },
    );
    await begin(client).tick();
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe("UNAVAILABLE");
  });

  it("other errors on signal propagate (not swallowed as not-found)", async () => {
    const { client, signal } = fakeClient();
    signal.mockRejectedValueOnce(new Error("boom"));
    state.rows = [row("hold.released")];
    expect(await begin(client).tick()).toEqual({ claimed: 1, published: 0, failed: 1 });
  });

  it("an AlreadyStarted error on a signal, or NotFound on start, is NOT treated as success", async () => {
    const { client, start, signal } = fakeClient();
    start.mockRejectedValueOnce(new WorkflowNotFoundError("x", "w", undefined));
    signal.mockRejectedValueOnce(new WorkflowExecutionAlreadyStartedError("x", "w", "t"));
    state.rows = [row("hold.created", 1), row("hold.released", 2)];
    expect(await begin(client).tick()).toEqual({ claimed: 2, published: 0, failed: 2 });
  });

  it("a failing row does not stop later rows in the batch", async () => {
    const { client, start } = fakeClient();
    start.mockRejectedValueOnce(new Error("first fails"));
    state.rows = [row("hold.created", 1), row("hold.created", 2)];
    expect(await begin(client).tick()).toEqual({ claimed: 2, published: 1, failed: 1 });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("a delivery that never answers fails with delivery_timeout instead of hanging", async () => {
    const { client, start } = fakeClient();
    start.mockImplementation(() => new Promise(() => undefined));
    const errors: Error[] = [];
    claimDueSpy.mockImplementation(
      async (_d: unknown, _l: number, handle: (r: OutboxRow) => Promise<void>) => {
        try {
          await handle(row("hold.created"));
        } catch (e) {
          errors.push(e as Error);
        }
        return { claimed: 1, published: 0, failed: 1 };
      },
    );
    const t0 = Date.now();
    await begin(client, { deliverTimeoutMs: 40 }).tick();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(errors.map((e) => e.message)).toEqual(["delivery_timeout"]);
  });

  it("a hung signal also times out", async () => {
    const { client, signal } = fakeClient();
    signal.mockImplementation(() => new Promise(() => undefined));
    state.rows = [row("hold.released")];
    expect(await begin(client, { deliverTimeoutMs: 30 }).tick()).toEqual({
      claimed: 1,
      published: 0,
      failed: 1,
    });
  });

  it("a fast delivery is not failed by the timeout and leaves no pending timer", async () => {
    vi.useFakeTimers();
    try {
      const { client } = fakeClient();
      state.rows = [row("hold.created")];
      const r = begin(client, { deliverTimeoutMs: 5000 });
      const before = vi.getTimerCount(); // the interval only
      expect(await r.tick()).toEqual({ claimed: 1, published: 1, failed: 0 });
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("relay loop", () => {
  it("ticks do not overlap while a claim is in flight", async () => {
    const { client } = fakeClient();
    let active = 0;
    let max = 0;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    claimDueSpy.mockImplementation(async () => {
      calls += 1;
      active += 1;
      max = Math.max(max, active);
      await gate;
      active -= 1;
      return { claimed: 0, published: 0, failed: 0 };
    });
    const r = begin(client, { intervalMs: 5 });
    await new Promise((res) => setTimeout(res, 80)); // ~16 intervals elapse
    expect(calls).toBe(1);
    release();
    await r.stop();
    expect(max).toBe(1);
  });

  it("keeps ticking at the interval after a pass completes", async () => {
    const { client } = fakeClient();
    begin(client, { intervalMs: 10 });
    await vi.waitFor(() => expect(claimDueSpy.mock.calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 2000,
    });
  });

  it("stop() halts further ticks and waits for the in-flight one", async () => {
    const { client } = fakeClient();
    let finished = false;
    claimDueSpy.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      finished = true;
      return { claimed: 0, published: 0, failed: 0 };
    });
    const r = begin(client, { intervalMs: 5 });
    await vi.waitFor(() => expect(claimDueSpy).toHaveBeenCalled());
    await r.stop();
    expect(finished).toBe(true);
    const n = claimDueSpy.mock.calls.length;
    await new Promise((res) => setTimeout(res, 50));
    expect(claimDueSpy.mock.calls.length).toBe(n);
  });

  it("a tick error is logged by stage only, never with the error text, and the loop survives", async () => {
    const { client } = fakeClient();
    const secret = "postgres://user:SENTINEL_PW@db.internal:5432/x";
    const lines: string[] = [];
    claimDueSpy.mockRejectedValue(
      Object.assign(new Error(`connect failed ${secret}`), { code: "ECONNREFUSED" }),
    );
    begin(client, { intervalMs: 10, log: (l) => void lines.push(l) });
    await vi.waitFor(() => expect(claimDueSpy.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 2000,
    });
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const l of lines) {
      expect(l).not.toContain("SENTINEL_PW");
      expect(l).not.toContain("postgres://");
      expect(l).not.toContain("ECONNREFUSED");
    }
    expect(lines[0]).toContain("tick");
  });

  it("the default logger does not leak secrets either", async () => {
    const { client } = fakeClient();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      claimDueSpy.mockRejectedValue(new Error("SENTINEL_PW"));
      begin(client, { intervalMs: 10 });
      await vi.waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 2000 });
      const all = [...spy.mock.calls, ...out.mock.calls].flat().join(" ");
      expect(all).not.toContain("SENTINEL_PW");
    } finally {
      spy.mockRestore();
      out.mockRestore();
    }
  });

  it("tick() itself rejects when claimDue rejects (callers see the failure)", async () => {
    const { client } = fakeClient();
    claimDueSpy.mockRejectedValue(new Error("down"));
    await expect(begin(client).tick()).rejects.toThrow("down");
  });
});

describe("relay abort on timeout", () => {
  it("aborts the signal given to withAbortSignal and fails with delivery_timeout", async () => {
    const { client, start } = fakeClient();
    let captured: AbortSignal | undefined;
    (client.workflow as unknown as Record<string, unknown>).withAbortSignal = (sig: AbortSignal, fn: () => Promise<unknown>) => {
      captured = sig;
      return new Promise((resolve, reject) => {
        sig.addEventListener("abort", () => reject(new Error("aborted by signal")));
        void fn().then(resolve, reject);
      });
    };
    start.mockImplementation(() => new Promise(() => undefined));
    const errors: Error[] = [];
    claimDueSpy.mockImplementation(async (_d: unknown, _l: number, handle: (r: OutboxRow) => Promise<void>) => {
      try {
        await handle(row("hold.created"));
      } catch (e) {
        errors.push(e as Error);
      }
      return { claimed: 1, published: 0, failed: 1 };
    });
    await begin(client, { deliverTimeoutMs: 30 }).tick();
    expect(captured).toBeDefined();
    expect(captured!.aborted).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("delivery_timeout");
    expect(errors[0]!.name).toBe("delivery_timeout"); // errorCode() stores name as last_error
  });

  it("does not abort a delivery that finishes in time", async () => {
    const { client } = fakeClient();
    let captured: AbortSignal | undefined;
    (client.workflow as unknown as Record<string, unknown>).withAbortSignal = (sig: AbortSignal, fn: () => Promise<unknown>) => {
      captured = sig;
      return fn();
    };
    state.rows = [row("hold.created"), row("hold.released", 2)];
    expect(await begin(client, { deliverTimeoutMs: 5000 }).tick()).toEqual({ claimed: 2, published: 2, failed: 0 });
    expect(captured!.aborted).toBe(false);
  });
});

describe("relay housekeeping", () => {
  it("calls purgePublished and purgeEndedHolds with 7 days once the period has elapsed", async () => {
    const { client } = fakeClient();
    begin(client, { intervalMs: 5, housekeepingMs: 30 });
    await vi.waitFor(() => expect(purgeEndedHolds).toHaveBeenCalled(), { timeout: 2000 });
    expect(purgePublished).toHaveBeenCalledWith(db, 7);
    expect(purgeEndedHolds).toHaveBeenCalledWith(db, 7);
  });

  it("does not run housekeeping before the period elapses", async () => {
    const { client } = fakeClient();
    begin(client, { intervalMs: 5, housekeepingMs: 3_600_000 });
    await vi.waitFor(() => expect(claimDueSpy.mock.calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 2000,
    });
    expect(purgePublished).not.toHaveBeenCalled();
    expect(purgeEndedHolds).not.toHaveBeenCalled();
  });

  it("runs at most once per period, not every tick", async () => {
    const { client } = fakeClient();
    begin(client, { intervalMs: 5, housekeepingMs: 200 });
    await new Promise((r) => setTimeout(r, 120));
    expect(claimDueSpy.mock.calls.length).toBeGreaterThan(5);
    expect(purgePublished.mock.calls.length).toBe(0);
  });

  it("a housekeeping failure is logged without the error text and does not stop the relay", async () => {
    const { client } = fakeClient();
    const lines: string[] = [];
    purgePublished.mockRejectedValue(new Error("postgres://u:SENTINEL_PW@h/db"));
    begin(client, { intervalMs: 5, housekeepingMs: 20, log: (l) => void lines.push(l) });
    await vi.waitFor(() => expect(lines.some((l) => l.includes("housekeeping"))).toBe(true), {
      timeout: 2000,
    });
    const before = claimDueSpy.mock.calls.length;
    await vi.waitFor(() => expect(claimDueSpy.mock.calls.length).toBeGreaterThan(before + 2), {
      timeout: 2000,
    });
    for (const l of lines) expect(l).not.toContain("SENTINEL_PW");
  });
});
