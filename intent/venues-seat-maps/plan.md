# Plan: venues, events and seat maps (read-only admin)

Status: draft (awaiting owner review)
Intent: [intent.md](intent.md) · Spec: [spec.md](spec.md)
Date: 2026-10-05

`pnpm typecheck`, `pnpm lint` and `pnpm test` stay green after every step.
Each step lists the spec ACs it covers so `/implement` can hand them to qa.
qa writes `*.test.ts(x)` and `*.int.test.ts` files; dev writes everything
else, including test harnesses under `src/` or `packages/config`.

Steps marked **⚑Pn** depend on a plan question below. Each has a
recommendation, but none is decided.

## Plan questions (spec ambiguities; owner to decide)

**P1. AC 4 ("no real venue names, people or addresses") can't be checked by
machine.** A test can't tell whether "Harbour Lights Theatre" exists. No
names/venues scanner exists today either; the spec says "extends the
existing repo hygiene test", but there is no such test.
**Recommend:** a new `test/repo/fixtures-hygiene.test.ts` that:

- checks that seed emails, if any, use `example.com`, and phones use
  07700 900xxx (GDPR-8);
- checks that every seed venue name ends in a fixed fictional marker,
  " (Example)", so a real-sounding name can't slip in unreviewed.

The rest stays with the reviewer.

**P2. Spec contradiction: the map is "marked as an image" but AC 12 wants an
accessible name on each access-seat element.** If the SVG has `role="img"`,
its children aren't in the accessibility tree, so per-seat names would never
be announced. Exposing all 5,000 seats as named elements would also flood a
screen reader.
**Recommend:** the SVG is `role="img"` with an `aria-label` summary (seat
counts, access seats, "see the seat table"). Each seat element carries a
`<title>` (pointer tooltip) and a `data-features` attribute with a
non-colour marker shape. AC 12 is then tested on the shape marker plus the
`<title>` text, not on the accessibility tree. The table remains the
assistive-technology path (A11Y-3).

**P3. Where Playwright's browser comes from.**
`test/repo/ci-workflow.test.ts` fixes the `integration` job at exactly two
run steps (install, `pnpm test:int`), so CI can't gain a
`playwright install` step. `affected.test.ts` also requires `test:int` to
start with the Docker preflight followed by `&& turbo build`.
**Recommend:** a second `globalSetup` in `vitest.int.config.ts` that runs
`playwright install chromium` (no `--with-deps`), so the CI workflow and
the `test:int` script stay unchanged.

- **Install time:** about 30 s on a cold CI cache; cached locally after the
  first run.
- **Fallback:** if CI lacks system libraries, switch to the runner's
  preinstalled Chrome with `channel: "chrome"`.

**P4. "Two new dev dependencies" in the spec is really three.**

- `playwright`: the library, driven from Vitest int tests. Not
  `@playwright/test`, which would add a second test runner.
- `@axe-core/playwright`: axe checks in the browser.
- `axe-core`: axe checks in jsdom unit tests.

**Recommend:** accept all three.

**P5. AC 8's "under 1 s on CI" is a flaky gate as written.**
**Recommend:** measure the layout request through `app.inject` after one
warm-up call, take the median of 5 calls, and assert it is under 1 s. Then
assert the JSON is under 1 MB. That times the API, not runner noise.

**P6. "Dev-only" venue list.** The spec says the `GET /venues` picker is
dev-only "documented as such" but doesn't say whether it is enforced.
**Recommend:** document only, as the spec says: a code comment and a
README line. Concern 5 already says admin isn't deployed. An env flag
could be added later by the auth intent.

## Steps

### Step 1: domain types and invariants

- **Files:**
  - `packages/domain/src/venues/types.ts`
  - `packages/domain/src/venues/invariants.ts`
  - `packages/domain/src/venues/access-features.ts`: the fixed list from
    F-4.
  - `packages/domain/src/venues/time.ts`: `formatInZone(utc, ianaZone)` for
    display.
  - Export from `packages/domain/src/index.ts`, using `.js` specifiers.
- **Change:**
  - Types for venue, layout, section (`reserved` | `ga`), seat, companion
    link, event and performance (layout per performance, F-1), with the
    F-7 fields.
  - `validateLayout(layout)` and `validateVenueGraph(graph)` return
    `Result<void, Violation[]>`. They cover every rule in AC 2, plus
    "performance layout belongs to the same venue".
- **Test** (qa, `packages/domain/test/venues/*.test.ts`):
  - Each AC 2 rule is rejected, and a valid graph passes.
  - `formatInZone` shows the right local time on both sides of a
    Europe/London clock change.
- **ACs:** 2, plus the DST row of the Failure modes table.

### Step 2: database schema and generated migration

- **Files:**
  - `packages/db/src/schema.ts`: the eight tables from the spec, UUID PKs,
    `venue_id` on every venue-owned table, composite FKs
    `(venue_id, parent_id)`, uniques, and a Postgres enum for access
    features.
  - `packages/db/migrations/0001_venues-seat-maps.sql` and `meta/*`, via
    `pnpm db:new venues-seat-maps` only. The directory is hook-protected.
- **Test:**
  - `pnpm db:check` passes.
  - qa extends `packages/db/test/migrate.int.test.ts`: after migrating, all
    eight tables exist, and inserting a `seat` whose `section_id` belongs to
    another venue fails on the composite FK.
- **ACs:** 1, and tenant enforcement at the database level (supports 6).

### Step 3: scoped read queries

- **Files:**
  - `packages/db/src/client.ts`: `createDb(url)` returns a Drizzle client
    and `close()`. It never logs the URL.
  - `packages/db/src/queries.ts`: `listVenues()` (the only unscoped export,
    marked dev-only, ⚑P6), `getVenue(venueId)`, `listEvents(venueId)`,
    `getEvent(venueId, eventId)` and `getLayoutView(venueId, layoutId)`.
  - Export from `packages/db/src/index.ts`.
- **Test** (qa):
  - Unit: every exported query except `listVenues` declares `venueId` as
    its first parameter (AC 9), via a TypeScript type-level test with
    `expectTypeOf`.
  - Integration, `packages/db/test/queries.int.test.ts`: against the seeded
    DB from step 4, cross-venue IDs return `null`.
- **ACs:** 9, and 6 at the database level.
- **Note:** AC 9 says "no unscoped read export". `listVenues` is the
  intentional dev-only exception from spec concern 4. The test lists it
  explicitly.

### Step 4: seed (⚑P1)

- **Files:**
  - `packages/db/src/seed/data.ts`: three invented venues (300 studio with
    GA, 1,200 theatre, 5,000 arena), layouts, access and companion seats,
    events, and performances, including one on a clock-change date.
    Generated programmatically for large sections.
  - `packages/db/src/seed/run.ts`: validate with the domain invariants,
    then upsert by natural keys in one transaction.
  - `packages/db/package.json` script `seed`.
  - Root `package.json`: `db:seed`.
- **Test** (qa):
  - `packages/db/test/seed.int.test.ts`: on an empty DB, the expected
    counts appear; a second run leaves counts unchanged; corrupting one
    seed item makes the script exit non-zero, name the rule, and write
    nothing.
  - `test/repo/fixtures-hygiene.test.ts`, per ⚑P1.
- **ACs:** 3, 4.

### Step 5: contracts

- **Files:**
  - `packages/contracts/src/venues.ts`: `VenueSummary`, `VenueDetail`,
    `EventSummary`, `EventDetail`, `PerformanceSummary`, `LayoutView` and
    `ErrorBody`, all `.strict()`, value and type sharing a name (the
    `health.ts` style).
- **Test** (qa, `packages/contracts/test/venues.test.ts`):
  - Valid samples parse; extra keys are rejected.
  - `companionOf` refers to a seat ID present in the same view.
- **ACs:** supports 5.

### Step 6: API database wiring and env

- **Files:**
  - `apps/api/src/env.ts`: adds a **required** `DATABASE_URL` with no
    default. It does not reuse the placeholder default in
    `packages/db/src/env.ts`, which is evaluated at import. Same
    "never echo the value" error style as `PORT`.
  - `apps/api/src/app.ts`: `buildApp(deps)`, where `deps` is a repository
    object (the step 3 query functions bound to a db). `/health` stays
    database-free.
  - `apps/api/src/index.ts`: create the db, run a `select 1` startup probe,
    and on failure log only the host and exit 1.
  - `apps/api/package.json`: add the `@boxoffice/db` dependency.
- **Test** (qa):
  - `apps/api/test/env.test.ts` gains: `DATABASE_URL` missing → error naming
    the variable; invalid → no value echoed.
  - The existing health tests pass with a fake repository.
- **ACs:** Failure modes "DB down at startup"; the `/health` independence
  rule.

### Step 7: API read routes (⚑P5)

- **Files:**
  - `apps/api/src/routes/venues.ts`: the five routes from the spec's
    Interfaces table, with Zod params (UUID; malformed → 400) and the
    response schemas from step 5.
    - A missing or cross-venue ID gives 404 `not_found`.
    - Database errors give 503 `unavailable` with no internals.
  - `apps/api/package.json`: `test:int` script (same pattern as `db`) and
    `testcontainers` dev dependency.
- **Test** (qa):
  - Unit, `apps/api/test/venues.test.ts` with a fake repository:
    - 404 for a cross-venue ID, with the body identical to a missing ID;
    - 400 for a malformed ID;
    - 503 when the repository throws;
    - every 200 body parses with its contract.
  - Integration, `apps/api/test/venues.int.test.ts`: Testcontainers
    Postgres, migrate, seed, then run AC 5, 6 and 7 for real, and AC 8 per
    ⚑P5.
- **ACs:** 5, 6, 7, 8.

### Step 8: admin env and API client

- **Files:**
  - `apps/admin/src/env.ts`: Zod `API_URL`, default
    `http://localhost:4000`. It lives under `src/` so the env-example
    collector finds it.
  - `apps/admin/src/api.ts`: typed fetchers that parse the step 5
    contracts, and an `ApiUnavailable` error.
  - `apps/admin/tsconfig.json` include `src`.
  - `.env.example`: add `API_URL` with a comment saying the admin default
    is `http://localhost:4000`.
  - `packages/config/serve-app.ts`: `startApp(appDir, { env? })` gains an
    optional extra-env parameter, so int tests can point admin at a test
    API.
- **Test** (qa):
  - `apps/admin/test/api.test.ts` with mocked fetch: a contract violation
    throws; a network error gives `ApiUnavailable`.
  - The existing `test/repo/env-example.test.ts` passes with `API_URL`
    added (AC 16).
- **ACs:** 16.

### Step 9: admin shell and list pages

- **Files:**
  - `apps/admin/app/layout.tsx`: header, nav and `main` landmarks, a
    skip link, and visible focus styles. Keep `lang="en-GB"` and the zoom
    rules.
  - `apps/admin/app/page.tsx`: the venue picker. It is dev-only, which is
    noted on the page.
  - `apps/admin/app/venues/[venueId]/page.tsx`: the venue, its layouts and
    its events.
  - `apps/admin/app/venues/[venueId]/events/[eventId]/page.tsx`:
    performances, with times via `formatInZone`.
  - `apps/admin/app/error.tsx`: heading plus retry link (AC 15).
  - All data pages set `export const dynamic = "force-dynamic"`, so
    `next build` in `test:int` never calls the API.
  - Dev dependency `axe-core`.
- **Test** (qa):
  - `apps/admin/test/pages.test.tsx`: render each page with stubbed data
    in jsdom, check landmarks, one `<h1>` and a title, and run axe with no
    serious or critical violations.
  - The error page renders a heading and a retry link.
  - The existing `page.test.tsx` is updated for the new home page.
- **ACs:** 10 (unit half, three pages), 15 (unit half).

### Step 10: seat-map page (⚑P2)

- **Files:**
  - `apps/admin/app/venues/[venueId]/layouts/[layoutId]/page.tsx`.
  - `apps/admin/src/seat-map/SeatMap.tsx`: SVG with shape markers per
    access feature, a legend, zoom-in, zoom-out and reset buttons (client
    component), and `role="img"` with a summary per ⚑P2.
  - `apps/admin/src/seat-map/SeatTable.tsx`: grouped by section with
    headings, showing rows, seats, features and companions, plus GA areas
    and capacity.
  - `apps/admin/src/seat-map/model.ts`: one view model that both
    components render from.
- **Test** (qa, `apps/admin/test/seat-map.test.tsx`):
  - AC 12: every access seat has a non-colour marker and a `<title>` that
    includes its features.
  - AC 13: the set of seats, features and companion pairs from the map
    equals the set from the table.
  - Zoom buttons change the view box.
  - axe passes on the page with the table expanded (AC 10).
- **ACs:** 10 (seat-map page, unit), 12, 13.

### Step 11: browser tests (⚑P3, ⚑P4)

- **Files:**
  - Root dev dependencies: `playwright` and `@axe-core/playwright`.
  - `packages/config/playwright-setup.ts`: a `globalSetup` that installs
    Chromium if missing (⚑P3), added to `vitest.int.config.ts` after the
    Docker preflight.
  - `apps/admin/test/support/stack.ts` (qa may write under `test/`): starts
    Postgres (Testcontainers), migrates, seeds, runs the API in-process on
    a free port, and runs admin via `startApp(..., { env: { API_URL } })`.
- **Test** (qa, `apps/admin/test/admin.int.test.ts`):
  - AC 10: an axe check in Chromium on all four pages, plus the seat-map
    page with the table expanded.
  - AC 11: the keyboard-only path from the spec, with a visible-focus check
    at each step (outline or box-shadow non-empty).
  - AC 14: at a 320 px viewport, `document.documentElement.scrollWidth` is
    at most 320, and the table is reachable.
  - AC 15 (browser half): stop the API, reload, and see the error page.
- **ACs:** 10, 11, 14, 15.
- **Risk:** if the cold Chromium download makes `integration` exceed about
  10 min, stop and report. The fallback is `channel: "chrome"` (⚑P3).

### Step 12: docs

- **Files:**
  - `README.md`:
    - a `pnpm db:seed` row in the commands table (the README test requires
      the script to exist from step 4);
    - local run steps (Postgres, seed, api, admin);
    - "admin is dev-only until auth" (⚑P6).
- **Test:** the existing README commands test in
  `test/repo/env-example.test.ts`.
- **ACs:** supports 16 and 17.

### Step 13: end-to-end verification (no new code)

- **Fresh clone:** `pnpm install --frozen-lockfile`, `typecheck`, `lint`,
  `test`, `db:check`, `test:int`.
- **Manual:** the spec's E2E step 3. Time the 5,000-seat map render. The
  F-2 target is under 2 s, measured by hand and not gated in CI.
- **CI:** all five required checks green on the PR (AC 17).
- **ACs:** 17, and every other AC rechecked.

## AC coverage

| AC  | Step    | AC  | Step      | AC  | Step  |
| --- | ------- | --- | --------- | --- | ----- |
| 1   | 2       | 7   | 7         | 13  | 10    |
| 2   | 1       | 8   | 7         | 14  | 11    |
| 3   | 4       | 9   | 3         | 15  | 9, 11 |
| 4   | 4       | 10  | 9, 10, 11 | 16  | 8     |
| 5   | 7       | 11  | 11        | 17  | 13    |
| 6   | 2, 3, 7 | 12  | 10        |     |       |

## Notes for /implement

- **Protected paths:** `packages/db/migrations/**` is generated only, via
  `pnpm db:new`.
- **Unchanged:** `ci.yml` and the `test:int` script (⚑P3).
- **Docker:** steps 2–4, 7 and 11 need Docker running.
- **New dependencies:** `@boxoffice/db` in api; `testcontainers` in api;
  `playwright`, `@axe-core/playwright` and `axe-core` (⚑P4). Any build
  script pnpm blocks needs an explicit `allowBuilds` entry.
- **Policy skills:** policy-accessibility applies to steps 9–11. GDPR, PCI
  and UK-refunds don't apply (no personal data, payments or prices).
