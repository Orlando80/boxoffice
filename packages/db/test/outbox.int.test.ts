import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/client.js";
import { backoffSeconds, claimDue, MAX_BACKOFF_SECONDS, purgePublished } from "../src/outbox.js";
import * as schema from "../src/schema.js";
import { buildSeed } from "../src/seed/data.js";
import { seedDatabase } from "../src/seed/run.js";

describe("outbox relay side (seeded Postgres)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let closeDb: () => Promise<void>;
  let sql: ReturnType<typeof postgres>;
  let venueId: string;
  const noop = async (): Promise<void> => {};

  const insertRows = async (n: number, extra = ""): Promise<number[]> => {
    const ids: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const [r] = await sql<{ id: string }[]>`
        insert into outbox (venue_id, type, aggregate_id, payload)
        values (${venueId}, 'hold.created', gen_random_uuid(), ${sql.json({ i, extra })})
        returning id`;
      ids.push(Number(r!.id));
    }
    return ids;
  };
  const row = async (id: number) => {
    const [r] = await sql<
      {
        published_at: Date | null;
        attempts: number;
        last_error: string | null;
        due_in: number;
      }[]
    >`select published_at, attempts, last_error,
        extract(epoch from (next_attempt_at - now()))::float8 as due_in
      from outbox where id = ${id}`;
    return r!;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(110_000)
      .start();
    const url = container.getConnectionUri();
    const graph = buildSeed();
    await seedDatabase(url, graph);
    const client = postgres(url, { max: 20 });
    db = drizzle(client, { schema });
    closeDb = () => client.end();
    sql = postgres(url, { max: 3 });
    venueId = graph.venues[0]!.id;
  }, 180_000);
  afterAll(async () => {
    await closeDb?.();
    await sql?.end();
    await container?.stop();
  }, 60_000);
  beforeEach(async () => {
    await sql`delete from outbox`;
  });

  it("backoffSeconds is 1,2,4,8,16 then capped at 30", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50, 2000].map(backoffSeconds)).toEqual([
      1, 2, 4, 8, 16, 30, 30, 30, 30,
    ]);
    expect(MAX_BACKOFF_SECONDS).toBe(30);
  });

  it("claims in id order, respects the limit, and marks handled rows published", async () => {
    const ids = await insertRows(5);
    const seen: number[] = [];
    const r = await claimDue(db, 3, async (o) => {
      seen.push(Number(o.id));
    });
    expect(r).toEqual({ claimed: 3, published: 3, failed: 0 });
    expect(seen).toEqual(ids.slice(0, 3));
    for (const id of ids.slice(0, 3)) expect((await row(id)).published_at).not.toBeNull();
    for (const id of ids.slice(3)) expect((await row(id)).published_at).toBeNull();
    expect(await claimDue(db, 100, noop)).toEqual({ claimed: 2, published: 2, failed: 0 });
    expect(await claimDue(db, 100, noop)).toEqual({ claimed: 0, published: 0, failed: 0 });
  });

  it("two concurrent claimDue calls never handle the same row", async () => {
    const ids = await insertRows(40);
    const handled: number[][] = [[], []];
    const slow = (bucket: number[]) => async (o: { id: number }) => {
      bucket.push(Number(o.id));
      await new Promise((r) => setTimeout(r, 150));
    };
    const [a, b] = await Promise.all([
      claimDue(db, 20, slow(handled[0]!)),
      claimDue(db, 20, slow(handled[1]!)),
    ]);
    expect(a.claimed + b.claimed).toBe(40);
    expect(a.claimed).toBe(20);
    expect(b.claimed).toBe(20);
    const inter = handled[0]!.filter((x) => handled[1]!.includes(x));
    expect(inter).toEqual([]);
    expect([...handled[0]!, ...handled[1]!].sort((x, y) => x - y)).toEqual(ids);
  });

  it("8 concurrent relays draining 200 rows handle each row exactly once", async () => {
    const ids = await insertRows(200);
    const counts = new Map<number, number>();
    const handle = async (o: { id: number }) => {
      counts.set(Number(o.id), (counts.get(Number(o.id)) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 2));
    };
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (let i = 0; i < 6; i += 1) await claimDue(db, 10, handle);
      }),
    );
    for (const id of ids) expect(counts.get(id) ?? 0).toBeLessThanOrEqual(1);
    const handledTotal = [...counts.values()].reduce((s, n) => s + n, 0);
    expect(handledTotal).toBe(counts.size);
    // Drain the rest and confirm everything was published exactly once overall.
    for (;;) {
      const r = await claimDue(db, 100, handle);
      if (r.claimed === 0) break;
    }
    for (const id of ids) expect(counts.get(id)).toBe(1);
  });

  it("a failing handler leaves the row unpublished, bumps attempts, backs off 1,2,4,8,16,30,30", async () => {
    const [id] = await insertRows(1);
    const expected = [1, 2, 4, 8, 16, 30, 30];
    for (let n = 1; n <= expected.length; n += 1) {
      await sql`update outbox set next_attempt_at = now() where id = ${id!}`;
      const r = await claimDue(db, 10, async () => {
        throw new Error("secret-message token=abc123 4242424242424242");
      });
      expect(r).toEqual({ claimed: 1, published: 0, failed: 1 });
      const o = await row(id!);
      expect(o.published_at).toBeNull();
      expect(o.attempts).toBe(n);
      expect(o.due_in).toBeLessThanOrEqual(expected[n - 1]!);
      expect(o.due_in).toBeGreaterThan(expected[n - 1]! - 3);
      expect(o.last_error).toBe("Error");
      expect(o.last_error).not.toContain("secret");
      // Not due again until the backoff has passed.
      expect(await claimDue(db, 10, noop)).toEqual({ claimed: 0, published: 0, failed: 0 });
    }
  });

  it("last_error is a short code and never carries message text", async () => {
    const [a, b, c, d] = await insertRows(4);
    const msg = "connect to db.internal.example:5432 failed password=hunter2";
    const handle = async (o: { id: number }) => {
      const id = Number(o.id);
      if (id === a) throw Object.assign(new Error(msg), { code: "ECONNREFUSED" });
      if (id === b) throw Object.assign(new Error(msg), { code: msg });
      if (id === c) throw msg;
      if (id === d) throw Object.assign(new Error(msg), { name: msg });
    };
    const r = await claimDue(db, 10, handle);
    expect(r).toEqual({ claimed: 4, published: 0, failed: 4 });
    expect((await row(a!)).last_error).toBe("ECONNREFUSED");
    for (const id of [b!, c!, d!]) {
      const e = (await row(id)).last_error;
      expect(e).not.toBeNull();
      expect(e!.length).toBeLessThanOrEqual(40);
      expect(e).not.toContain("hunter2");
      expect(e).not.toContain("db.internal");
    }
  });

  it("a failing row does not stop the batch, and is never dropped", async () => {
    const ids = await insertRows(3);
    const r = await claimDue(db, 10, async (o) => {
      if (Number(o.id) === ids[1]) throw new Error("x");
    });
    expect(r).toEqual({ claimed: 3, published: 2, failed: 1 });
    expect((await row(ids[0]!)).published_at).not.toBeNull();
    expect((await row(ids[1]!)).published_at).toBeNull();
    expect((await row(ids[2]!)).published_at).not.toBeNull();
    expect(await sql`select 1 from outbox where id = ${ids[1]!}`).toHaveLength(1);
  });

  it("a row that later succeeds is published", async () => {
    const [id] = await insertRows(1);
    await claimDue(db, 10, async () => {
      throw new Error("x");
    });
    await sql`update outbox set next_attempt_at = now() where id = ${id!}`;
    expect(await claimDue(db, 10, noop)).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect((await row(id!)).published_at).not.toBeNull();
  });

  it("published and not-yet-due rows are not claimed", async () => {
    const [pub, later, due] = await insertRows(3);
    await sql`update outbox set published_at = now() where id = ${pub!}`;
    await sql`update outbox set next_attempt_at = now() + interval '1 hour' where id = ${later!}`;
    const seen: number[] = [];
    await claimDue(db, 10, async (o) => {
      seen.push(Number(o.id));
    });
    expect(seen).toEqual([due]);
  });

  it("purgePublished deletes only published rows older than the age", async () => {
    const [oldPub, newPub, oldUnpub, boundary] = await insertRows(4);
    await sql`update outbox set published_at = now() - interval '10 days' where id = ${oldPub!}`;
    await sql`update outbox set published_at = now() - interval '1 day' where id = ${newPub!}`;
    await sql`update outbox set created_at = now() - interval '30 days' where id = ${oldUnpub!}`;
    await sql`update outbox set published_at = now() - interval '6 days 23 hours' where id = ${boundary!}`;
    expect(await purgePublished(db, 7)).toBe(1);
    const left = await sql<{ id: string }[]>`select id from outbox order by id`;
    expect(left.map((r) => Number(r.id))).toEqual([newPub, oldUnpub, boundary]);
    expect(await purgePublished(db, 7)).toBe(0);
  });
});
