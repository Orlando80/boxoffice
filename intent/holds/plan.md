# Plan: holds with Temporal timers (create, expire, release)

Status: approved (owner accepted Q1–Q10 recommendations, 2026-10-06)
Intent: [intent.md](intent.md) · Spec: [spec.md](spec.md)
Date: 2026-10-06

`pnpm typecheck`, `pnpm lint` and `pnpm test` stay green after every step.
Each step lists the spec ACs it covers, so `/implement` can hand them to qa.
qa writes `*.test.ts(x)` and `*.int.test.ts` files. dev writes everything
else, including test helpers under `src/`, `test/support/` or
`packages/config`.

Steps marked **⚑Qn** depend on a plan question below. Implement the
recommended option (accepted by the owner).

## Plan questions (resolved: owner accepted every recommendation, 2026-10-06)

**Q1. The spec says the domain purity test covers `reservation` (AC 3).
It doesn't.** `packages/domain/test/venues/purity.test.ts` reads only
`src/venues/` (non-recursive) and asserts at least 4 files. It also bans
number fields whose names start with `total`, `amount`, `price` and so on
(a money guard), so a field like `totalPlaces: number` would fail.
**Recommend:**

- qa changes the test to walk all of `packages/domain/src/` recursively,
  which also covers `result.ts` and `index.ts`.
- dev uses names like `placeCount` in the domain.

**Q2. The relay writes `outbox`, but AC 9 says only `holds.ts` writes hold
tables.** AC 9 lists the hold, line, inventory and access-need tables and
doesn't mention `outbox`. AC 6 needs the outbox insert in the same
transaction as the hold write, which puts it in `holds.ts`. The relay then
updates and deletes outbox rows from the worker.
**Recommend:**

- `packages/db/src/holds.ts`: the only writer of `hold`, `hold_seat`,
  `hold_ga`, `ga_inventory` and `hold_access_need`, and the only place that
  **inserts** outbox rows.
- `packages/db/src/outbox.ts`: the only place that claims, marks and purges
  outbox rows. The worker calls it and never writes SQL itself.
- The AC 9 repo test enforces both rules.

**Q3. Drizzle 0.45 has no `bytea` column, which `hold.token_hash` uses.**
**Recommend:** a `customType` in `schema.ts` with
`dataType: () => "bytea"`, mapped to `Buffer`. It keeps the spec's type,
and `pnpm db:new` generates it normally. The alternative, a hex `text`
column, would be a spec change.

**Q4. The seed's October performances will soon count as started.** Today
is 2026-10-06. Most seed performances start between 2026-10-23 and
2026-10-25, so int tests that hold seats on them would fail after that.
**Recommend:**

- Leave the seed unchanged.
- dev adds `packages/db/test/support/performances.ts`, a test-only helper.
  `futurePerformance(sql, { venueSlug, eventSlug, layoutName, daysAhead })`
  inserts a performance on a seed event and layout, starting `now() + N
days`.
- For "has started", the same helper takes a negative `daysAhead`.
- Every int and browser test uses it, so no test depends on the calendar.

**Q5. `ErrorBody` is a strict enum, and the spec adds error bodies with extra
fields.** For example, `seats_unavailable` carries `seatIds` and
`sectionIds`, and `invalid_hold` carries `rule`. A strict `ErrorBody` would
reject those at serialization, which turns a 409 into a 503.
**Recommend:**

- `ErrorBody`'s enum gains only `extension_limit` and `hold_ended`.
- New strict schemas `SeatsUnavailableBody` and `InvalidHoldBody` are used
  as the 409 and 422 response schemas on the hold routes.
- qa updates the contract tests that pin the `ErrorBody` enum: the
  `expectTypeOf` and unknown-code rows. Admin never parses error bodies, so
  nothing else changes.

**Q6. Fastify has no logger today, so AC 14 ("no token in API logs") has
nothing to capture.** **Recommend:**

- `buildApp(repos, opts?)` gains `opts.logger`.
- `index.ts` turns on Fastify's built-in pino at level `info` with
  `redact: ["req.headers['hold-token']"]`, as a safety net. The default
  request serializer already leaves headers out.
- Tests pass a writable stream that collects lines.
- The token never goes in a URL, so logged URLs are safe.

**Q7. A test only lets `workflows.ts` import from `@temporalio/workflow`.**
`apps/worker/test/connection.test.ts:30-34` enforces it.
`proxyActivities` needs the activity signatures.
**Recommend:**

- Keep the test unchanged.
- `workflows.ts` declares a `HoldActivities` interface inline.
- `activities.ts` imports that type from `workflows.ts` (type-only) and
  `satisfies` it, so the two can't drift apart.

**Q8. `HOLD_LENGTH_SECONDS` and `.env.example`.**

- The spec has both API and worker read `HOLD_LENGTH_SECONDS`, but the
  worker reads expiry from the database and never needs it.
- `test/repo/env-example.test.ts` fails unless every key read in `src`
  appears in `.env.example`.
- Agents can't read or write `.env.example` (a deny rule), so the owner
  edits it.

**Recommend:**

- Only the API reads `HOLD_LENGTH_SECONDS`.
- The owner adds `#HOLD_LENGTH_SECONDS=600` (commented, test-only) to
  `.env.example` during step 7. `DATABASE_URL` is already there, so the
  worker reading it adds no new key.
- `holds.ts` takes the length as a parameter. Int tests pass 2 s directly,
  without env.

**Q9. AC 22 wants "held" in each held seat's accessible name, but the map is
`role="img"`.** That's the same issue as intent 2's P2: the children of a
`role="img"` element aren't in the accessibility tree.
**Recommend** the intent 2 approach:

- AC 22 is tested on the `data-held` attribute, the hatch pattern and
  "held" glyph, and "held" in the seat's `<title>` text.
- The table's Status column is the path for assistive technology, and is
  compared seat-for-seat against the map (A11Y-3, A11Y-4).

**Q10. Which venue the admin browser tests use for held state.** The arena
performance page would be about 5,000 SVG groups plus a 5,000-row table.
That adds time to `pnpm test:int` (AC 25's budget is 3 min) without testing
anything the theatre doesn't.
**Recommend:**

- AC 21 and AC 23 run on a future theatre performance (about 1,200 seats).
- The arena is covered only by AC 15's availability API timing.

## Steps

### Step 1: domain reservation rules (⚑Q1)

- **Files:**
  - `packages/domain/src/reservation/types.ts`
    - `HoldStatus`, `SeatRole` (`standard` | `access` | `companion`).
    - `HoldRequest`: seat lines with optional `accessNeed`, and GA lines.
    - `HoldFacts`: for the requested IDs only. Each seat's section kind,
      layout, access features and companion link, plus each GA section's
      kind and layout, and the performance's layout and start time.
  - `packages/domain/src/reservation/rules.ts`
    - Constants: `HOLD_LENGTH_SECONDS = 600`, `MAX_EXTENSIONS = 10`,
      `MAX_PLACES = 10`.
    - `ACCESS_NEED_CATEGORIES = ACCESS_FEATURES` (H-5).
    - `validateHoldRequest(request, facts, now)` returns
      `Result<ValidatedHold, HoldViolation[]>`.
      - `now` is passed in; the domain never reads the clock.
      - Each violation has a snake_case `rule`, matching
        `venues/invariants.ts`.
      - It checks every AC 1 rule. A seat is an access seat if it has any
        access feature (H-4).
  - `packages/domain/src/reservation/state.ts`
    - `canTransition(status, action)`.
    - `checkExtension(extensionsUsed)` returns `ok` or `extension_limit`.
  - `packages/domain/src/index.ts`: export the reservation modules
    (`.js` specifiers).
- **Test** (qa):
  - `packages/domain/test/reservation/*.test.ts`:
    - each AC 1 rule rejected, valid mixed requests pass, companions not
      counted towards 10;
    - the state machine;
    - the 11th extension rejected.
  - `purity.test.ts` walks `src/` recursively (⚑Q1).
- **ACs:** 1, 2, 3.

### Step 2: schema and generated migration (⚑Q3)

- **Files:**
  - `packages/db/src/schema.ts`:
    - the six new tables from the spec, a `bytea` `customType` (⚑Q3), and
      enums `hold_status` and `seat_role`. `hold_access_need.need` reuses
      the `access_feature` enum.
    - the partial unique index `hold_seat_active_uq` on
      `(performance_id, seat_id) WHERE ended_at IS NULL`, using
      `uniqueIndex().on().where()`.
    - checks named `*_ck`, composite FKs named `*_fk`;
    - `outbox.id` as a bigint identity, plus the partial index on unpublished
      rows;
    - `performance` gains `performance_venue_id_id_uq`.
  - `packages/db/migrations/0002_holds.sql` and `meta/*`, generated only by
    `pnpm db:new holds`. The directory is hook-protected.
- **Test:**
  - `pnpm db:check` passes.
  - qa extends `packages/db/test/migrate.int.test.ts`:
    - a second active `hold_seat` for the same performance and seat fails
      with 23505, and succeeds once the first has `ended_at` set;
    - `ga_inventory.held` above capacity fails with 23514;
    - `status = 'active'` with `ended_at` set fails with 23514;
    - a `hold_seat` whose hold belongs to another performance or venue fails
      with 23503;
    - the enum labels match the domain constants.
- **ACs:** 4. This step also gives the database-level safety behind AC 5.

### Step 3: hold write module (⚑Q2, ⚑Q4)

- **Files:**
  - `packages/db/src/holds.ts`. Every function takes `(db, venueId, ...)`.
    - **`createHold(db, venueId, performanceId, request, { lengthSeconds })`,
      in one transaction:**
      1. Load `HoldFacts` for the requested IDs and call
         `validateHoldRequest`.
      2. Lazily expire due holds that touch the requested seats or GA
         sections of this performance (conditional update on
         `status = 'active' AND expires_at <= now()`). Each one ends its
         lines, decrements GA and deletes its needs, then writes
         `hold.expired`.
      3. Upsert `ga_inventory` from section capacity
         (`ON CONFLICT DO NOTHING`), then run the conditional GA increments
         in sorted section order.
      4. Insert `hold` and its seat lines in sorted seat order. A 23505 on
         `hold_seat_active_uq` means unavailable, and the code reports which
         seat IDs are taken.
      5. Insert `hold_access_need` and the `hold.created` outbox row.
      - It returns `{ holdId, token, expiresAt, extensionsRemaining }`, or a
        typed failure (`seats_unavailable` with IDs, or `invalid_hold` with
        the rule).
      - The token is `randomBytes(32)` encoded as base64url. Only
        `sha256(token)` is stored.
      - On a 40P01 or 40001 error it retries the whole transaction once,
        then throws.
    - **`extendHold`, `releaseHold` and `getHold`** each take
      `(db, venueId, holdId, token)`.
      - They look up by venue, ID and token hash. Any mismatch is `null`
        (404).
      - Extend is `UPDATE … WHERE status = 'active' AND expires_at > now()`
        with the domain extension check.
      - Release is idempotent on an already-released hold.
      - Each writes its outbox row in the same transaction.
    - **`getHoldExpiry(db, venueId, holdId)` and
      `expireHoldIfDue(db, venueId, holdId)`** are for the worker.
      `expireHoldIfDue` returns `{ ended: true, lagMs }` or
      `{ ended: false, expiresAt }`.
    - **`purgeEndedHolds(db, olderThanDays)`** deletes ended holds older
      than the given age (H-7).
    - All end paths share one private `endHold(tx, …)`.
  - `packages/db/src/index.ts`: export `holds.ts`.
  - `packages/db/test/support/performances.ts`: dev writes this test helper
    (⚑Q4).
- **Test** (qa, `packages/db/test/holds.int.test.ts`, seeded Postgres, future
  performances via ⚑Q4):
  - AC 5 concurrency: 20 parallel creates on one seat; 20 parallel GA
    creates of 1 against capacity 5. Use a test-only GA section, or the
    remaining capacity of the theatre/studio GA.
  - AC 6:
    - each change writes exactly one outbox row;
    - a forced failure (a stubbed outbox insert that throws, through an
      injected hook) leaves no rows behind.
  - AC 7 lazy expiry.
  - AC 8:
    - needs are deleted when the hold ends;
    - no outbox payload contains a need value or the token.
  - Extend, release and wrong-token behaviour at the data layer.
- **ACs:** 5, 6, 7, 8. The data-layer parts of 11–14.

### Step 4: outbox module and writers test (⚑Q2)

- **Files:**
  - `packages/db/src/outbox.ts`
    - `claimDue(db, limit, handle)`: one transaction. It selects due
      unpublished rows `ORDER BY id FOR UPDATE SKIP LOCKED LIMIT n`, calls
      `handle(row)` for each, then sets `published_at`, or bumps `attempts`
      and `next_attempt_at` with exponential backoff capped at 30 s, plus a
      `last_error` code.
    - `purgePublished(db, olderThanDays)`.
  - `packages/db/src/index.ts`: export it.
- **Test** (qa):
  - `packages/db/test/outbox.int.test.ts`:
    - two concurrent `claimDue` calls never get the same row;
    - a failing handler leaves the row unpublished, with `attempts`
      incremented and the backoff growing up to the cap;
    - purge removes only rows older than the age given.
  - `test/repo/hold-writers.test.ts` (AC 9, ⚑Q2), modelled on
    `versions.test.ts`:
    - It scans `git ls-files` `.ts` files under `apps/` and `packages/`,
      excluding tests, `schema.ts` and `migrations/`.
    - Hold tables may only be written by Drizzle `insert`, `update` or
      `delete` calls, or by SQL text, in `holds.ts`.
    - Outbox inserts are allowed only in `holds.ts`, and outbox updates and
      deletes only in `outbox.ts`.
- **ACs:** 9. The relay half of 19 and 20 (retry and backoff).

### Step 5: performance and availability reads

- **Files:**
  - `packages/db/src/queries.ts`:
    - `getPerformance(db, venueId, performanceId)` returns the performance
      with its event name and layout ID, or `null`.
    - `getAvailability(db, venueId, performanceId)` returns held seat IDs
      and per-GA-section `held`/`capacity`. It counts only holds that are
      `active AND expires_at > now()`, summed from `hold_ga` rather than
      `ga_inventory`, so overdue holds don't count (H-8).
- **Test** (qa):
  - `queries.type.test.ts`: add both functions to the export list and add
    `expectTypeOf` lines.
  - `queries.int.test.ts`:
    - cross-venue IDs give `null`;
    - an overdue but not yet ended hold isn't counted;
    - arena availability with no holds has 0 held seats and GA held 0 of 500.
- **ACs:** the data part of 15.

### Step 6: contracts (⚑Q5)

- **Files:**
  - `packages/contracts/src/holds.ts`: `CreateHoldRequest`, `HoldCreated`,
    `HoldView`, `PerformanceDetail`, `PerformanceAvailability`,
    `SeatsUnavailableBody`, `InvalidHoldBody`.
    - All are `.strict()` and use `z.uuid()` and `z.iso.datetime()`.
    - The `accessNeed` and `role` enums come from domain constants.
    - `HoldView` has no `token` or need field.
  - `packages/contracts/src/venues.ts`: `ErrorBody` gains
    `extension_limit` and `hold_ended`.
  - `packages/contracts/src/index.ts`: export `holds.ts`.
- **Test** (qa, `packages/contracts/test/holds.test.ts`, plus an update to
  `venues.test.ts`):
  - valid samples parse;
  - extra keys are rejected at every level;
  - the enums match the domain constants;
  - `HoldView` rejects a `token` key;
  - the `ErrorBody` type and unknown-code rows are updated.
- **ACs:** these support 10–15.

### Step 7: API hold, performance and availability routes (⚑Q5, ⚑Q6, ⚑Q8)

- **Files:**
  - `apps/api/src/routes/holds.ts`: the six routes from the spec's
    Interfaces table.
    - The `Hold-Token` header is validated as base64url of 43 characters.
      A missing or malformed token is 404, not 400, so it reveals nothing.
    - Response schemas: 201/200 as in the spec, 409 with
      `SeatsUnavailableBody` or `ErrorBody`, 422 with `InvalidHoldBody`,
      404/400/503 with `ErrorBody`.
    - It copies the venue routes' error handler and `guard()`.
  - `apps/api/src/routes/venues.ts`: export `guard`, the error handler and
    the shared bodies, or move them to `routes/common.ts`. No behaviour
    change.
  - `apps/api/src/app.ts`: `buildApp(repos?, opts?)` registers the hold
    routes when `repos.holds` is present, and passes `opts.logger` through
    (⚑Q6).
  - `apps/api/src/repository.ts`: binds the new queries and the `holds.ts`
    functions, with `lengthSeconds` from env.
  - `apps/api/src/env.ts`: `HOLD_LENGTH_SECONDS`, an integer 1–3600,
    default 600.
  - `apps/api/src/index.ts`: turns on the pino logger with header redaction
    (⚑Q6).
  - `apps/admin/test/support/stack.ts`: follows the new `buildApp`
    signature. dev owns this file.
  - **Owner:** add `#HOLD_LENGTH_SECONDS=600` to `.env.example` (⚑Q8).
- **Test** (qa):
  - `apps/api/test/holds.test.ts`, unit tests with a fake repo:
    - status mapping for every error;
    - a wrong or missing token gives 404 with a body identical to an
      unknown hold;
    - a 409 body parses as `SeatsUnavailableBody`;
    - a captured logger stream has no token after create, extend and
      release (AC 14).
  - `apps/api/test/holds.int.test.ts`, with seeded Postgres and a future
    performance:
    - AC 10–13 end to end;
    - the AC 14 database check: `token_hash` is 32 bytes and isn't equal
      to the token;
    - AC 15: arena availability median-of-5 under 1 s.
  - `apps/api/test/env.test.ts`: `HOLD_LENGTH_SECONDS` default, range and
    error.
  - Update `fakeRepo` and `repoFor` in the existing venue tests for the new
    `getPerformance`.
- **ACs:** 10, 11, 12, 13, 14, 15.

### Step 8: worker relay, workflow and activities (⚑Q7)

- **Files:**
  - `apps/worker/package.json`: add `@boxoffice/db` and, as a dev
    dependency, `@testcontainers/postgresql`.
  - `apps/worker/src/env.ts`: `DATABASE_URL` is required and Zod-validated.
    Errors name the variable only.
  - `apps/worker/src/workflows.ts`: `holdWorkflow(holdId, venueId)`.
    - It uses `proxyActivities<HoldActivities>` with retries, and a
      `released` signal through `defineSignal`/`setHandler`.
    - It loops `condition(() => released, untilExpiry)` → `expireHoldIfDue`.
    - It imports from `@temporalio/workflow` only, with `HoldActivities`
      declared inline (⚑Q7).
  - `apps/worker/src/activities.ts`: `createActivities(db)` returns
    `{ getHoldExpiry, expireHoldIfDue }` and `satisfies HoldActivities`.
    `expireHoldIfDue` writes one JSON log line
    `{ event: "hold.expired", holdId, venueId, lag_ms }`.
  - `apps/worker/src/relay.ts`: `startRelay({ db, client, taskQueue,
intervalMs = 500, batch = 100 })` returns `{ stop }`.
    - `hold.created`: `client.workflow.start(holdWorkflow, { workflowId:
"hold-<id>", workflowIdConflictPolicy: USE_EXISTING })`, and
      `WorkflowExecutionAlreadyStartedError` counts as success.
    - `hold.released`: signal `released`, and `WorkflowNotFoundError` counts
      as success.
    - Other event types are marked published.
    - Housekeeping once a minute: `purgePublished` and `purgeEndedHolds`
      at 7 days.
  - `apps/worker/src/worker.ts`: `createWorker` takes `activities`.
  - `apps/worker/src/index.ts`:
    - connects the database (logging the host only on failure) and the
      Temporal client;
    - starts the worker and relay, and stops both on SIGTERM;
    - keeps the existing secrecy rules in `connection.test.ts`.
- **Test** (qa):
  - `apps/worker/test/env.test.ts`: update the `toEqual` cases for
    `DATABASE_URL`, and add required and invalid cases.
  - `apps/worker/test/relay.test.ts`, unit tests with a fake client and a
    fake `claimDue`:
    - handler per type;
    - already-started and not-found count as success;
    - other errors propagate, so the row is retried.
  - `connection.test.ts`: still passes unchanged (⚑Q7), and the `index.ts`
    secrecy test covers `DATABASE_URL`.
- **ACs:** the unit halves of 18, 19 and 20.

### Step 9: worker integration tests (Postgres + Temporal)

- **Files:**
  - `apps/worker/test/support/holds-stack.ts`, written by dev:
    - Postgres through Testcontainers, with migrations and seed;
    - `getTemporalTarget()`;
    - a worker on a random task queue with real activities;
    - the relay at 100 ms;
    - helpers to create holds through `holds.ts` with `lengthSeconds: 2`
      on a future performance (⚑Q4).
- **Test** (qa, `apps/worker/test/holds.int.test.ts`):
  - AC 16: expiry within 7 s, one `hold.expired` row, a lag line captured.
  - AC 17: an extended hold expires after its new time, not the original
    one.
  - AC 18: a released hold's workflow completes within 5 s, checked with
    `describe()`.
  - AC 19: the same `hold.created` delivered twice gives one workflow.
  - AC 20: with the relay pointed at an unreachable Temporal address,
    `attempts` rises and the seat is still holdable through lazy expiry.
    After switching to the real target, the workflow starts and the hold
    expires.
- **ACs:** 16, 17, 18, 19, 20.

### Step 10: admin performance page and held state (⚑Q9)

- **Files:**
  - `apps/admin/src/api.ts`: `getPerformance` and `getAvailability`,
    following the existing pattern.
  - `apps/admin/src/seat-map/model.ts`:
    - `buildModel(layout, availability?)`;
    - a `held` flag on seats (alongside `marker`, so it combines with
      wheelchair or companion), and `held` on GA sections;
    - "held" added to `seatTitle`;
    - held counts added to the summary.
  - `apps/admin/src/seat-map/SeatMap.tsx`:
    - a hatch `<pattern>` overlay and a held glyph;
    - `data-held`;
    - a legend item;
    - GA label "N of M held".
  - `apps/admin/src/seat-map/SeatTable.tsx`: a Status column
    (`Available` / `Held`), and the GA paragraph shows "N of M held".
  - `apps/admin/app/globals.css`: hatch and held styles. Contrast is 3:1
    for UI parts.
  - `apps/admin/app/venues/[venueId]/performances/[performanceId]/page.tsx`:
    - modelled on the layout page;
    - shows the performance time in the venue zone, an "as of" time with a
      Refresh link, the map and the table;
    - handles `ServiceUnavailable` and `notFound`.
  - `apps/admin/app/venues/[venueId]/events/[eventId]/page.tsx`: the
    date/time row header links to the performance page. The layout link
    stays.
- **Test** (qa):
  - `apps/admin/test/seat-map.test.tsx`:
    - AC 22 under ⚑Q9: held markers are non-colour, `data-held` is set,
      and the table Status matches the map for every seat, including a held
      access seat and its companion;
    - GA "N of M held".
  - `apps/admin/test/pages.test.tsx`:
    - the performance page renders with axe clean (jsdom);
    - the not-found and unavailable states;
    - AC 24: no token, hold ID or need value in the HTML;
    - the event page link.
  - Both test files' `vi.mock("../src/api")` factories gain the new
    functions.
  - `apps/admin/test/api.test.ts`: the new client functions.
- **ACs:** 22, 24, and the jsdom part of 21.

### Step 11: admin browser tests (⚑Q10)

- **Files:**
  - `apps/admin/test/support/stack.ts`: dev adds a future theatre
    performance and creates holds through `holds.ts` (⚑Q4, ⚑Q10):
    - one standard seat;
    - one access seat with a need, plus its companion;
    - GA isn't used here, because the theatre has none. It's covered in
      jsdom.
- **Test** (qa, `apps/admin/test/admin.int.test.ts`):
  - AC 21: an axe sweep of the performance page.
  - AC 23: keyboard-only from the event page to the performance, into the
    Stalls seat table, to the held seat's row, with visible focus.
    This reuses the existing `tabTo` and `settle` helpers.
- **ACs:** 21, 23.

### Step 12: docs

- **Files:** `README.md`:
  - a "Run the worker locally" section using
    `pnpm --filter @boxoffice/worker dev`, written as prose, not as a
    commands-table row, because `env-example.test.ts` requires every table
    row to be a root script;
  - `curl` examples for create, extend and release;
  - a note that the API and worker must not be deployed publicly before auth
    or rate limiting (spec concern 8).
- **Test:** the existing README checks in `env-example.test.ts` pass.
- **ACs:** none directly. This supports the E2E.

### Step 13: end-to-end verification (no new code)

- **Fresh clone** (short path; see the Windows MAX_PATH note):
  `pnpm install --frozen-lockfile`, `typecheck`, `lint`, `test`,
  `db:check`, `test:int`.
- **Timing:** compare `pnpm test:int` wall time with `main` on the same
  machine (AC 25: no more than 3 min longer).
- **Manual:** the spec's E2E step 3, with the Temporal UI showing
  `hold-<id>` completed.
- **CI:** all five required checks green on the PR.
- **ACs:** 25, and every other AC rechecked.

## AC coverage

| AC  | Step | AC  | Step | AC  | Step    |
| --- | ---- | --- | ---- | --- | ------- |
| 1   | 1    | 10  | 7    | 19  | 4, 8, 9 |
| 2   | 1    | 11  | 3, 7 | 20  | 4, 8, 9 |
| 3   | 1    | 12  | 3, 7 | 21  | 10, 11  |
| 4   | 2    | 13  | 3, 7 | 22  | 10      |
| 5   | 2, 3 | 14  | 3, 7 | 23  | 11      |
| 6   | 3    | 15  | 5, 7 | 24  | 10      |
| 7   | 3    | 16  | 9    | 25  | 7, 13   |
| 8   | 3    | 17  | 9    |     |         |
| 9   | 4    | 18  | 8, 9 |     |         |

## Notes for /implement

- **Protected paths:**
  - `packages/db/migrations/**` is generated only, with `pnpm db:new
holds`.
  - `.env.example` is owner-only (step 7, ⚑Q8).
- **Unchanged:** `ci.yml`, the `test:int` script and the Dockerfiles. turbo
  prune pulls `@boxoffice/db` into the worker image automatically.
- **Docker:** steps 2–5, 7, 9 and 11 need Docker running.
- **New dependencies:** `@boxoffice/db` and, as a dev dependency,
  `@testcontainers/postgresql` in the worker. No new third-party packages;
  `@temporalio/testing` isn't used, and tests rely on real timers with a
  2 s hold length.
- **Step pairs:** steps 3 and 4 can share one dev agent (both are in
  `packages/db`), and so can steps 8 and 9.
- **Policy skills:**
  - policy-accessibility applies to steps 1 (A11Y-5/8/9/10 rules), 10 and 11.
  - policy-gdpr applies to steps 3 and 7: delete the need when the hold
    ends, and keep tokens and needs out of logs and payloads (GDPR-3/4/7).
  - PCI and UK refunds don't apply.
