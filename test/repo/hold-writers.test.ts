import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOLDS = "packages/db/src/holds.ts";
const OUTBOX = "packages/db/src/outbox.ts";

// Drizzle identifiers (schema.ts) and SQL table names.
const HOLD_IDENTS = ["hold", "holdSeat", "holdGa", "gaInventory", "holdAccessNeed"];
const HOLD_SQL = ["hold", "hold_seat", "hold_ga", "ga_inventory", "hold_access_need"];

type Op = "insert" | "update" | "delete";
export interface Write {
  table: "hold" | "outbox";
  op: Op;
  via: "drizzle" | "sql" | "alias";
}

const IDENT_TO_GROUP: Record<string, "hold" | "outbox"> = {
  ...Object.fromEntries(HOLD_IDENTS.map((i) => [i, "hold" as const])),
  outbox: "outbox",
};
const SQL_TO_GROUP: Record<string, "hold" | "outbox"> = {
  ...Object.fromEntries(HOLD_SQL.map((i) => [i, "hold" as const])),
  outbox: "outbox",
};

/** Removes // and block comments (crudely, but good enough for a guard). */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\w])\/\/[^\n]*/g, "$1");
}

/** Every write to a hold table or the outbox found in `text`. */
export function findWrites(text: string): Write[] {
  const src = stripComments(text);
  const out: Write[] = [];
  const idents = Object.keys(IDENT_TO_GROUP).join("|");
  const drizzleRe = new RegExp(
    String.raw`\.\s*(insert|update|delete)\s*\(\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?(${idents})\s*[,)]`,
    "g",
  );
  for (const m of src.matchAll(drizzleRe)) {
    out.push({ table: IDENT_TO_GROUP[m[2]!]!, op: m[1] as Op, via: "drizzle" });
  }
  // Importing a table symbol under another name hides it from the check above.
  const aliasRe = new RegExp(String.raw`\b(${idents})\s+as\s+[A-Za-z_$]`, "g");
  for (const m of src.matchAll(aliasRe)) {
    out.push({ table: IDENT_TO_GROUP[m[1]!]!, op: "insert", via: "alias" });
    out.push({ table: IDENT_TO_GROUP[m[1]!]!, op: "update", via: "alias" });
    out.push({ table: IDENT_TO_GROUP[m[1]!]!, op: "delete", via: "alias" });
  }
  const names = Object.keys(SQL_TO_GROUP)
    .sort((a, b) => b.length - a.length)
    .join("|");
  const sqlRe = new RegExp(
    String.raw`\b(insert\s+into|update|delete\s+from|truncate(?:\s+table)?|copy|merge\s+into)\s+(?:only\s+)?(?:"?[A-Za-z_]+"?\s*\.\s*)?"?(${names})"?(?![\w$])`,
    "gi",
  );
  for (const m of src.matchAll(sqlRe)) {
    const verb = m[1]!.toLowerCase();
    const op: Op =
      verb.startsWith("insert") || verb === "copy" || verb.startsWith("merge")
        ? "insert"
        : verb === "update"
          ? "update"
          : "delete";
    out.push({ table: SQL_TO_GROUP[m[2]!.toLowerCase()]!, op, via: "sql" });
    if (verb.startsWith("merge"))
      out.push({ table: SQL_TO_GROUP[m[2]!.toLowerCase()]!, op: "update", via: "sql" });
  }
  return out;
}

/** Rule check: returns a human-readable description for each disallowed write. */
export function violations(path: string, writes: Write[]): string[] {
  const bad: string[] = [];
  for (const w of writes) {
    const allowed =
      w.table === "hold" ? path === HOLDS : w.op === "insert" ? path === HOLDS : path === OUTBOX;
    if (!allowed) bad.push(`${path}: ${w.op} on ${w.table} (${w.via})`);
  }
  return bad;
}

const TEST_PATH = /(^|\/)(test|tests|__tests__)\/|\.(test|spec|int\.test)\.[cm]?[jt]sx?$/;
export function inScope(f: string): boolean {
  return (
    /^(apps|packages)\//.test(f) &&
    /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f) &&
    !TEST_PATH.test(f) &&
    !/(^|\/)schema\.ts$/.test(f) &&
    !/(^|\/)migrations\//.test(f) &&
    !/(^|\/)node_modules\//.test(f)
  );
}

function git(args: string[]): string[] {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
}
function candidateFiles(): string[] {
  const all = [...git(["ls-files"]), ...git(["ls-files", "--others", "--exclude-standard"])];
  return [...new Set(all)].filter(inScope);
}

describe("matcher (non-vacuous)", () => {
  const w = (s: string) => findWrites(s).map((x) => `${x.op}:${x.table}`);

  it.each([
    ["await tx.insert(hold).values(x)", ["insert:hold"]],
    ["db.update(holdSeat).set({})", ["update:hold"]],
    ["tx.delete(holdGa).where(x)", ["delete:hold"]],
    ["tx\n  .update(\n    gaInventory)\n  .set(x)", ["update:hold"]],
    ["db.delete(schema.holdAccessNeed)", ["delete:hold"]],
    ["await tx.insert(outbox).values(r)", ["insert:outbox"]],
    ["db.update(outbox).set(x)", ["update:outbox"]],
    ["db.delete(outbox)", ["delete:outbox"]],
    ["sql`INSERT INTO hold_seat (a) values (1)`", ["insert:hold"]],
    ["sql`update hold set status = 'x'`", ["update:hold"]],
    ["sql`delete from public.hold_ga where 1=1`", ["delete:hold"]],
    ['sql`DELETE FROM "ga_inventory"`', ["delete:hold"]],
    ["sql`truncate table hold_access_need`", ["delete:hold"]],
    ["sql`truncate hold`", ["delete:hold"]],
    ["sql`insert into outbox (a) values (1)`", ["insert:outbox"]],
    ["sql`update outbox set attempts = 1`", ["update:outbox"]],
    ["sql`with d as (delete from hold returning id) select 1`", ["delete:hold"]],
    ["sql`copy hold_seat from stdin`", ["insert:hold"]],
  ])("detects %j", (text, expected) => {
    expect(w(text)).toEqual(expected);
  });

  it("detects an aliased import of a table symbol", () => {
    expect(findWrites('import { hold as h } from "@boxoffice/db/schema";').length).toBeGreaterThan(
      0,
    );
  });

  it.each([
    "tx.select().from(hold).where(x)",
    "db.select({ id: hold.id }).from(holdSeat)",
    "// tx.insert(hold).values(x)",
    "/* sql`delete from hold` */",
    "sql`select * from hold_seat`",
    "sql`update holder set a = 1`",
    "sql`insert into hold_seat_archive values (1)`",
    "db.insert(venue).values(x)",
    "tx.update(holdersTable)",
    "const msg = 'the hold insert failed'",
  ])("ignores %j", (text) => {
    expect(findWrites(text)).toEqual([]);
  });

  it("applies the ownership rules", () => {
    const hold: Write = { table: "hold", op: "insert", via: "drizzle" };
    const obIns: Write = { table: "outbox", op: "insert", via: "drizzle" };
    const obUpd: Write = { table: "outbox", op: "update", via: "sql" };
    const obDel: Write = { table: "outbox", op: "delete", via: "sql" };
    expect(violations(HOLDS, [hold, obIns])).toEqual([]);
    expect(violations(OUTBOX, [obUpd, obDel])).toEqual([]);
    expect(violations("apps/worker/src/relay.ts", [hold])).toHaveLength(1);
    expect(violations("packages/db/src/queries.ts", [hold])).toHaveLength(1);
    expect(violations(OUTBOX, [hold])).toHaveLength(1);
    expect(violations(OUTBOX, [obIns])).toHaveLength(1);
    expect(violations(HOLDS, [obUpd])).toHaveLength(1);
    expect(violations(HOLDS, [obDel])).toHaveLength(1);
    expect(violations("apps/worker/src/relay.ts", [obIns, obUpd, obDel])).toHaveLength(3);
  });

  it("scope excludes tests, schema.ts and migrations but includes everything else", () => {
    expect(inScope("packages/db/test/holds.int.test.ts")).toBe(false);
    expect(inScope("packages/db/test/support/performances.ts")).toBe(false);
    expect(inScope("apps/api/src/foo.test.ts")).toBe(false);
    expect(inScope("packages/db/src/schema.ts")).toBe(false);
    expect(inScope("packages/db/migrations/0001.ts")).toBe(false);
    expect(inScope("packages/db/src/holds.ts")).toBe(true);
    expect(inScope("apps/worker/src/relay.ts")).toBe(true);
    expect(inScope("apps/admin/app/page.tsx")).toBe(true);
    expect(inScope("test/repo/versions.test.ts")).toBe(false);
  });
});

describe("hold table writers (AC 9, Q2)", () => {
  const read = (f: string) => readFileSync(resolve(root, f), "utf8");

  it("the scanner sees the real writers (holds.ts and outbox.ts)", () => {
    const files = candidateFiles();
    expect(files).toContain(HOLDS);
    expect(files).toContain(OUTBOX);
    expect(files.length).toBeGreaterThan(10);
    const h = findWrites(read(HOLDS));
    for (const op of ["insert", "update", "delete"] as const) {
      expect(h.some((x) => x.table === "hold" && x.op === op)).toBe(true);
    }
    expect(h.some((x) => x.table === "outbox" && x.op === "insert")).toBe(true);
    const o = findWrites(read(OUTBOX));
    expect(o.some((x) => x.table === "outbox" && x.op === "update")).toBe(true);
    expect(o.some((x) => x.table === "outbox" && x.op === "delete")).toBe(true);
  });

  it("only holds.ts writes hold tables and inserts outbox rows; only outbox.ts updates or deletes them", () => {
    const offenders: string[] = [];
    for (const f of candidateFiles()) {
      let text: string;
      try {
        text = read(f);
      } catch {
        continue;
      }
      offenders.push(...violations(f, findWrites(text)));
    }
    expect(offenders).toEqual([]);
  });

  it("a planted writer would be caught", () => {
    const planted = "export const x = (tx) => tx.update(holdSeat).set({ endedAt: null });";
    expect(violations("apps/worker/src/sneaky.ts", findWrites(planted))).toHaveLength(1);
  });
});
