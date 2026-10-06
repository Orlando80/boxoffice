# Spec: holds with Temporal timers (create, expire, release)

Status: approved
Intent: [intent.md](intent.md)
Date: 2026-10-06

## Goal

Let a caller hold reserved seats and general-admission (GA) places for one
performance. Holds can be extended and released by their token, and they
expire on a Temporal timer. A double hold is impossible by construction. The
outbox between Postgres and Temporal means no expiry is ever lost. Admin
shows held state per performance, read-only. This is Boxoffice's first
workflow, first outbox and first write API. Intent 4 (GA sales) turns holds
into orders, and intent 5 hardens hold creation under contention.

## Non-goals

- Staff allocations (press, sponsor, house seats) and staff release of
  access seats.
- Orders, payments, prices, confirmation emails. Holds carry no money.
- Customer pages, the countdown UI and the 20-second warning (A11Y-5's UI
  side, which comes in intent 4).
- `SELECT ... FOR UPDATE SKIP LOCKED` on seats, property tests, the k6 soak
  gate and oversell alerts (intent 5).
- Idempotent hold creation (`Idempotency-Key`); see concern 9.
- Per-venue hold length, waitlists, price tiers, on-sale windows.
- Outbox consumers other than the hold workflow.
- Sign-in, roles, rate limiting. Deploying the API or worker anywhere public.
- A dashboard for hold-expiry lag. This intent only logs the number (H-7).

## Design

### Where each part lives

| Layer                         | Adds                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/domain/reservation` | Pure hold rules: request validation against layout facts, the hold state machine (`active` → `released` \| `expired`), expiry and extension arithmetic, limits, access/companion rules. No I/O (the existing purity test covers it). |
| `packages/db`                 | Schema for holds, GA inventory and outbox; one migration via `pnpm db:new holds`. Adds `holds.ts`, the only module that writes hold tables. It calls the domain rules and writes the outbox row in the same transaction.             |
| `packages/contracts`          | Zod schemas for the hold API and per-performance availability.                                                                                                                                                                       |
| `apps/api`                    | Hold endpoints and an availability endpoint. The API talks only to Postgres. It never calls Temporal.                                                                                                                                |
| `apps/worker`                 | Gains `DATABASE_URL`. Runs the outbox **relay** loop next to the Temporal worker, plus `holdWorkflow` and its activities.                                                                                                            |
| `apps/admin`                  | A new performance page with the seat map and table showing held state. The event page's performance table links to it.                                                                                                               |

### Holds

- A hold belongs to one venue and one performance. It contains one or more
  **seat lines** (a reserved seat, with role `standard`, `access` or
  `companion`) and/or **GA lines** (a GA section and a quantity ≥ 1).
- **Token:** creating a hold returns a token made of 32 random bytes,
  base64url-encoded. Only its SHA-256 hash is stored. Extend, release and
  read require the token in a `Hold-Token` header, never in the URL. A wrong
  token gives the same 404 as a missing hold.
- **Length and extension (H-1):** `expires_at = now() + 10 min` at creation.
  Extend sets `expires_at = now() + 10 min` and increments
  `extensions_used`. The cap is 10 extensions, so a hold lives at most about
  110 min. All times come from the database clock (`now()`), never the app's
  clock.
- **State machine:** `active` → `released` (by token) or `expired` (by timer
  or lazily, see below). Both end states are terminal. Ending a hold sets
  `ended_at` on the hold and its lines, decrements GA inventory, deletes its
  access-need rows and writes the outbox event, all in one transaction.
- **What "active" means:** `status = 'active' AND expires_at > now()`. Reads
  (availability, hold view) use this definition, so a late Temporal timer
  never makes a seat look held after its time.
- **Lazy expiry:** when a create finds a conflicting hold that is still
  `active` but past `expires_at`, it expires that hold in the same
  transaction (writing `hold.expired`) and then proceeds. The workflow
  that wakes later finds the hold already ended and stops.
- **Validation (domain, before any write):**
  - Every seat is in a reserved section of the performance's layout, and
    every GA line refers to a GA section of that layout.
  - The performance hasn't started.
  - There are 1–10 places in total (H-2). Companion seats don't count.
  - Reserved seats and GA may be mixed, across sections.
  - No seat is repeated.
- **All-or-nothing (H-3):** if any seat is held, or a GA line exceeds
  what's left, nothing is held. The response lists the unavailable seat IDs
  and GA section IDs, never anything about who holds them.

### Access and companion seats

- **Access seat:** any seat with at least one access feature. This matches
  how admin and the seed count access seats today (H-4, concern 3).
- An access seat can be held only as role `access`, with a declared
  **access-need category** from a fixed list (H-5). Nothing is checked
  beyond the category.
- **Companion:** a seat linked as companion to an access seat can be held
  only as role `companion`, in the same hold as its linked access seat, and
  only one per access seat (H-6). It can't be held on its own.
- When the hold ends, these seats are free again and are still access-only
  or companion-only, because that's a property of the seat. This is "back to
  the access pool" for this intent. No pool state is modelled (H-4), and
  nothing ever turns an access seat into a general seat.
- The access-need category is stored in its own table, apart from the hold
  (GDPR-4). It's deleted when the hold ends. It never appears in outbox
  payloads, logs, API responses or admin (concern 6).

### No double holds (simple safety)

- **Seats:** a partial unique index on `hold_seat (performance_id, seat_id)
WHERE ended_at IS NULL`. Concurrent creates for one seat give exactly one
  winner. The loser gets 409.
- **GA:** a `ga_inventory` row per (performance, GA section) with
  `CHECK (held BETWEEN 0 AND capacity)`. It's created on first use from the
  section's capacity. Holding runs `UPDATE ... SET held = held + n WHERE
held + n <= capacity`, and zero rows updated means 409.
- **Lock order:** inserts and updates run in sorted ID order (GA sections,
  then seats) so two creates can't deadlock each other. A detected deadlock
  or serialization failure is retried once, then returns 503.
- Intent 5 replaces this with the reservation engine. These constraints stay
  as the backstop.

### Outbox, relay and workflow

- **Outbox row:** `type`, `aggregate_id` (hold ID), `venue_id`, `payload`
  (IDs and times only), `created_at`, `published_at`, `attempts`,
  `next_attempt_at`, `last_error` (a short code, no message text). Every
  hold state change writes exactly one row in the same transaction:
  `hold.created`, `hold.extended`, `hold.released` or `hold.expired`.
- **Relay** (in the worker process):
  - Polls every 500 ms for unpublished rows due now, in batches of up to
    100, claiming them with `FOR UPDATE SKIP LOCKED` so a second relay
    instance is safe. This locks outbox rows, not seats; seat locking stays
    in intent 5.
  - Handles rows in `id` order, per type:
    - `hold.created`: start `holdWorkflow` with workflow ID `hold-<holdId>`.
      If it's already started, that counts as success.
    - `hold.released`: signal `released`. If the workflow is gone, that
      counts as success.
    - `hold.extended`, `hold.expired`: no Temporal call. They're marked
      published for future consumers.
  - On failure: `attempts += 1`, then exponential backoff, capped at 30 s.
    The row is never dropped.
  - Deletes published rows older than 7 days (H-7).
- **`holdWorkflow(holdId, venueId)`:**
  1. Run activity `getHoldExpiry` → `{ status, expiresAt }`. If the hold
     isn't active, stop.
  2. Sleep until `expiresAt`, or wake early on the `released` signal.
  3. Run activity `expireHoldIfDue`. It ends the hold only if it is
     `active AND expires_at <= now()`. If the hold was extended meanwhile,
     it returns the new `expiresAt`, and the workflow goes back to step 2.
  - Extensions need no signal, because they only move expiry later. Release
    sends a signal only so the workflow ends early; correctness doesn't
    depend on it.
- **Hold-expiry lag:** `expireHoldIfDue` logs one structured line per expiry
  with `holdId`, `venueId` and `lag_ms = ended_at − expires_at` (H-7).

### Admin

- **New page `/venues/[venueId]/performances/[performanceId]`:** the
  performance's time, its layout and the seat map and table, now with held
  state. Each row in the event page's performances table links to it. The
  existing layout page is unchanged.
- **Held seats:**
  - The map draws a hatch pattern plus a "held" glyph on the seat marker,
    and the seat's accessible name includes "held".
  - The table gains a **Status** column (`Available` / `Held`).
  - The legend explains the new marker (A11Y-4).
- **GA areas** show "N of M held" as text.
- The page is a snapshot with "Held state as of HH:MM:SS (venue time)" and
  a Refresh link. It doesn't poll or update live.
- Admin never shows tokens, hold IDs or access-need categories. A held
  access seat shows as "Held", like any other held seat.

## Acceptance criteria (testable)

**Domain (unit)**

1. `packages/domain/reservation` rejects each of these, with a named rule:
   - a seat outside the performance's layout;
   - a GA line on a reserved section, or a seat in a GA section;
   - a duplicate seat;
   - 0 or more than 10 places (companions excluded);
   - a performance that has started;
   - an access seat held without an access-need category, or with one
     outside the list;
   - a companion seat held without its linked access seat in the same hold;
   - a companion seat that isn't linked to an access seat in the hold;
   - a second companion for one access seat.
2. The state machine allows only `active → released` and `active →
expired`. The 11th extension is rejected with `extension_limit`.
3. The existing domain purity test covers `reservation` (no I/O imports).

**Data (integration, Testcontainers Postgres)**

4. `pnpm db:new holds` produces the only new migration, and `pnpm db:check`
   passes. Nothing under `packages/db/migrations` is edited by hand.
5. **Concurrency:** 20 parallel creates for the same seat give exactly 1
   success and 19 conflicts. 20 parallel creates of 1 GA place against
   capacity 5 give exactly 5 successes. `ga_inventory.held` is never above
   capacity.
6. **Atomicity:** every hold state change writes exactly one outbox row in
   the same transaction. A forced failure after the hold insert leaves
   neither a hold nor an outbox row.
7. **Lazy expiry:** a hold with `expires_at` in the past and no workflow
   running doesn't block a new hold on the same seat. The old hold becomes
   `expired` with exactly one `hold.expired` row.
8. Ending a hold (release or expiry) deletes its access-need rows. No outbox
   payload contains an access-need category or a token (asserted over every
   row written by the test suite).
9. Only `packages/db/src/holds.ts` writes the hold, line, inventory and
   access-need tables. This is enforced by a test that greps for writes to
   those tables elsewhere.

**API (integration, seeded)**

10. `POST /venues/:venueId/performances/:performanceId/holds` returns 201
    with a body that parses as `HoldCreated` (`holdId`, `token`,
    `expiresAt`, `extensionsRemaining: 10`). Repeating it for the same seats
    returns 409 `seats_unavailable` listing exactly the conflicting IDs.
11. Extend with the right token returns 200 with a later `expiresAt` and
    `extensionsRemaining` one lower. The 11th extend returns 409
    `extension_limit`. Extending an ended hold returns 409 `hold_ended`.
12. Release returns 200 with status `released`, and the seats are available
    at once. Releasing again returns 200 with the same body (idempotent).
13. A wrong, missing or other hold's token returns 404, the same as an
    unknown hold. A hold, performance or seat from venue B used under venue
    A's path returns 404 or 422 and never 500.
14. The token is never stored. The DB holds a 32-byte hash that doesn't
    equal the token. Neither the token nor an access-need category appears
    in API logs during the test run (captured logger).
15. `GET /venues/:venueId/performances/:performanceId/availability` returns
    held seat IDs and per-GA-section `held`/`capacity`, counting only active
    holds (`expires_at > now()`). It responds in under 1 s for the
    5,000-seat arena.

**Workflow and relay (integration, Postgres + Temporal)**

16. With `HOLD_LENGTH_SECONDS=2`, a created hold becomes `expired` within
    7 s, with one `hold.expired` row and a lag log line. The seat is then
    available.
17. An extended hold doesn't expire at its original time, and expires after
    the new one.
18. A released hold's workflow completes within 5 s of release.
19. **Duplicate delivery:** delivering the same `hold.created` row twice
    starts one workflow and both deliveries are marked published.
20. **Temporal down:** with Temporal unreachable, outbox rows stay
    unpublished with `attempts` rising. Once Temporal is back, the workflow
    starts and the hold expires (immediately, if its time has already
    passed). Meanwhile lazy expiry keeps the seat holdable.

**Admin (unit + browser)**

21. The performance page renders seeded data with one held reserved seat,
    one held access seat with its companion, and GA partly held. There are
    no serious or critical axe violations (A11Y-11).
22. Held seats are distinguishable without colour. Each held seat's SVG
    element has the hatch or glyph marker and "held" in its accessible name.
    The table's Status column matches the map for every seat (A11Y-3,
    A11Y-4).
23. A keyboard-only test goes from the event page to a performance and
    reaches a held seat's row in the table, with visible focus at every step
    (A11Y-2, A11Y-11).
24. No token, hold ID or access-need category appears in the page's HTML.

**Repo**

25. `.env.example` gains `DATABASE_URL` for the worker and documents
    `HOLD_LENGTH_SECONDS`. The env-example test passes. CI stays green on
    all five required checks. `pnpm test:int` takes no more than 3 minutes
    longer than on `main`.

## Data model impact

These tables are new. Each carries `venue_id`, with composite foreign keys
to same-venue parents.

| Table              | Key columns                                                                                                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hold`             | `id`, `venue_id`, `performance_id`, `token_hash` (bytea, unique), `status` (`active` \| `released` \| `expired`), `created_at`, `expires_at`, `extensions_used` (0–10), `ended_at`; `CHECK ((status = 'active') = (ended_at IS NULL))`; unique `(venue_id, id, performance_id)` for line FKs |
| `hold_seat`        | `venue_id`, `hold_id`, `performance_id`, `seat_id`, `role` (`standard` \| `access` \| `companion`), `ended_at`; partial unique `(performance_id, seat_id) WHERE ended_at IS NULL`; FK `(venue_id, hold_id, performance_id)` → `hold`                                                         |
| `hold_ga`          | `venue_id`, `hold_id`, `performance_id`, `section_id`, `quantity` (≥ 1), `ended_at`                                                                                                                                                                                                          |
| `ga_inventory`     | PK `(performance_id, section_id)`, `venue_id`, `capacity`, `held`; `CHECK (held BETWEEN 0 AND capacity)`                                                                                                                                                                                     |
| `hold_access_need` | `venue_id`, `hold_id`, `seat_id`, `need` (enum, H-5); deleted when the hold ends                                                                                                                                                                                                             |
| `outbox`           | `id` (bigint identity), `venue_id`, `type`, `aggregate_id`, `payload` (jsonb), `created_at`, `published_at`, `attempts`, `next_attempt_at`, `last_error`; partial index on `(next_attempt_at, id) WHERE published_at IS NULL`                                                                |

Changes to existing tables:

- `performance` gains unique `(venue_id, id)`, so hold tables can reference
  it with a composite FK.

Retention:

- Ended holds and their lines are deleted 7 days after `ended_at`.
- Published outbox rows are deleted after 7 days.
- Both are done by the relay's housekeeping step, never by hand (H-7).

Nothing stores money. The only sensitive field is `hold_access_need.need`
(concern 6).

## Interfaces

**HTTP API (JSON, Zod contracts in `packages/contracts`)**

| Method + path                                                   | Auth         | Success                       |
| --------------------------------------------------------------- | ------------ | ----------------------------- |
| `POST /venues/:venueId/performances/:performanceId/holds`       | none         | 201 `HoldCreated`             |
| `GET /venues/:venueId/holds/:holdId`                            | `Hold-Token` | 200 `HoldView`                |
| `POST /venues/:venueId/holds/:holdId/extend`                    | `Hold-Token` | 200 `HoldView`                |
| `DELETE /venues/:venueId/holds/:holdId`                         | `Hold-Token` | 200 `HoldView` (released)     |
| `GET /venues/:venueId/performances/:performanceId`              | none         | 200 `PerformanceDetail`       |
| `GET /venues/:venueId/performances/:performanceId/availability` | none         | 200 `PerformanceAvailability` |

- **`CreateHoldRequest`:**
  `{ seats: [{ seatId, role, accessNeed? }], ga: [{ sectionId, quantity }] }`
- **`HoldView`:**
  `{ holdId, performanceId, status, expiresAt, extensionsRemaining, seats: [{ seatId, role }], ga: [{ sectionId, quantity }] }`.
  It has no token and no access need.
- **`PerformanceAvailability`:**
  `{ performanceId, asOf, heldSeatIds: [], ga: [{ sectionId, held, capacity }] }`
- **Errors:** `ErrorBody.error` gains `seats_unavailable` (409, with
  `seatIds` and `sectionIds`), `extension_limit` (409), `hold_ended` (409)
  and `invalid_hold` (422, with `rule`). The existing `not_found`,
  `bad_request` and `unavailable` stay. No error carries internals.

**Temporal (task queue `boxoffice`)**

- Workflow `holdWorkflow(holdId, venueId)`, with workflow ID `hold-<holdId>`
  and signal `released`.
- Activities `getHoldExpiry` and `expireHoldIfDue`.

**Outbox event types**

- `hold.created`, `hold.extended`, `hold.released`, `hold.expired`.
- Payload: `{ holdId, venueId, performanceId, expiresAt?, endedAt? }`.

**Env**

- `worker`: `DATABASE_URL` (new, Zod-validated, never logged).
- `api` and `worker`: `HOLD_LENGTH_SECONDS` (default 600, range 1–3600).
  It's for tests; production uses the default. The worker doesn't need it
  for correctness, because expiry is read from the database.

**Commands:** `pnpm db:new holds` (once). No new root scripts.

## Failure modes

| Failure                                                   | Behaviour                                                                                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Two creates race for a seat or the last GA place          | The unique index or conditional update picks one winner; the other gets 409 (AC 5).                                          |
| Deadlock or serialization failure on create               | Retried once, then 503 `unavailable`; nothing half-written.                                                                  |
| API crashes after commit, before responding               | The hold exists but the caller has no token. It expires on its timer (concern 9).                                            |
| Relay down, or Temporal down                              | Outbox rows wait and retry with backoff; lazy expiry and the `expires_at > now()` read rule keep seats correct (AC 20).      |
| Crash after starting the workflow, before marking the row | Redelivery is harmless: "already started" counts as success (AC 19).                                                         |
| Timer fires late                                          | Readers already see the hold as ended at `expires_at`; the lag is logged.                                                    |
| Extend arrives as the hold expires                        | The database decides: `UPDATE ... WHERE status = 'active' AND expires_at > now()`. Zero rows updated means 409 `hold_ended`. |
| Release and expiry race                                   | Both are conditional on `status = 'active'`, so only one ends the hold and only one end event is written.                    |
| Signal to a completed workflow                            | Treated as delivered.                                                                                                        |
| Worker can't reach the database                           | Activities fail and Temporal retries them. The relay logs the DB host only and keeps retrying. The process doesn't exit.     |
| Performance or layout data inconsistent with request      | 422 `invalid_hold` with the rule name. Cross-venue IDs give 404.                                                             |

## End-to-end verification step

1. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`,
   `pnpm test` and `pnpm db:check`.
2. Run `pnpm test:int`. It covers concurrency, atomicity, lazy expiry, the
   workflow and relay against Temporal, and the admin axe and keyboard
   tests.
3. Locally:
   - Start Postgres and run `pnpm temporal:dev` and `pnpm db:seed`.
   - Start `api` with `HOLD_LENGTH_SECONDS=60`, then start `worker` and
     `admin`.
   - With `curl`:
     - Create a hold on two theatre seats plus an access seat (with a
       category) and its companion. Check that the response has a token
       and `extensionsRemaining: 10`.
     - Open the performance in admin and check that the four seats show
       as Held in both the map and the table.
     - Extend the hold once, then create a second hold on one of the same
       seats and check that it returns 409.
     - Wait for expiry and refresh admin: the seats show Available. The
       Temporal UI (:8233) shows `hold-<id>` completed, and the worker log
       has the lag line.
     - Create and release a third hold, and check that its workflow
       completes at once.
4. Open the PR. All five CI checks pass.

## Flagged concerns

1. **A11Y-5: extension cap vs on-sale fairness.** Ten extensions of
   10 minutes let one caller keep scarce seats for about 110 minutes. During
   a busy on-sale that may be unfair to people in a queue. A11Y-5 says to
   flag this, not drop it. → The cap is exactly 10, and nothing else
   shortens it. Revisit when the on-sale queue intent lands; changing the
   cap below 10 would need a new decision record.
2. **A11Y-5 UI side is deferred.** The 20-second warning, one-action extend
   and announcing milestones need a customer UI, which comes in intent 4. →
   The API exposes `expiresAt` and `extensionsRemaining` so that UI can
   comply. Nothing here blocks it.
3. **A11Y-8/A11Y-10: what counts as an access seat.** Today any seat with any
   access feature is an access seat, including `aisle`, `extra_legroom` and
   `near_exit`. Requiring a declared need for those may lock up seats that
   many venues sell normally. → The spec follows the current model (any
   feature means access-only) for consistency with admin and the seed. Owner
   to confirm, or to name which features make a seat access-only (H-4).
4. **A11Y-8: does the declared need have to match the seat?** → Any category
   from the list is accepted for any access seat. That is self-declared,
   without gatekeeping. Matching (e.g. wheelchair spaces only for
   `wheelchair`) would protect wheelchair spaces but turns a category into
   an eligibility check. Owner to choose (H-5).
5. **A11Y-10: "only venue staff release them".** No staff release exists,
   so access and companion seats stay access-only for good. This intent
   never makes them general seats. → This matches `decisions/0003`; staff
   release comes with the allocations intent.
6. **GDPR-4, GDPR-3, GDPR-7: the access-need category.** It isn't linked to
   a person yet, but becomes health data once intent 4 ties a hold to a
   buyer. → It's stored in its own table, apart from the hold, and deleted
   when the hold ends (in the same transaction, plus the 7-day sweep). It's
   never in outbox payloads, logs, API responses or admin (AC 8, 14, 24).
   Explicit consent (GDPR-4) has to be collected by intent 4's UI before a
   category reaches this API. Intent 4's spec must also say how the category
   moves from the hold to the order and what its retention clock is (30 days
   after the event).
7. **CLAUDE.md "reservation changes go through `packages/domain/reservation`"
   vs domain purity.** `packages/domain` has a test that forbids I/O, so it
   can't do the writes. → The domain decides (validation, state transitions,
   expiry), and `packages/db/src/holds.ts` writes. It's the only writer of
   hold tables (AC 9). Owner to confirm this is how the rule is meant.
8. **Unauthenticated write API.** Anyone who can reach the API can hold
   every seat of every performance for about 110 minutes per hold, which
   denies the inventory to everyone else. The intent puts rate limiting and
   auth out of scope. → Today nothing deploys the API (deploy.yml only
   builds images). The API and worker must not run anywhere public until a
   rate-limit or auth intent lands. Owner to note this for the deploy
   intent, like admin in intent 2.
9. **No idempotent create.** If a client times out and retries, it can strand
   its first hold (it has no token for it) until expiry, and its retry may
   get 409 for its own seats. → Accepted for an API with no customer UI.
   Intent 4 adds `Idempotency-Key` before buyers use it.
10. **The worker gains database credentials.** Until now the worker needed
    only Temporal. → `DATABASE_URL` is read and validated at startup and
    never logged. In deployed environments it becomes a Fly secret on the
    worker app.
11. **Intent 2 table change.** `performance` gains a unique `(venue_id, id)`
    constraint in the new migration. It's additive, and existing data
    already satisfies it.

## Decisions (owner, 2026-10-06)

The owner accepted every recommendation below (H-1 to H-9) and the handling
proposed in Flagged concerns 1–11: the cap is exactly 10 extensions; any
access feature makes a seat access-only; any need category is accepted for
any access seat; the domain decides and `packages/db/src/holds.ts` is the
only writer; the API and worker are never deployed publicly before auth or
rate limiting; idempotent create is deferred to intent 4.

| #   | Question (intent open question)                 | Recommendation                                                                                                                                                                                                                            |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-1 | Hold length and extension (1)                   | 10 min default. Each extend resets expiry to now + 10 min. Cap of exactly 10 extensions, so the maximum lifetime is about 110 min. There's no separate lifetime limit.                                                                    |
| H-2 | Hold size (2)                                   | 1–10 places per hold. Companion seats don't count. Reserved and GA can be mixed, across sections of one performance.                                                                                                                      |
| H-3 | Partial availability (3)                        | All-or-nothing. A 409 lists the unavailable seat and GA section IDs.                                                                                                                                                                      |
| H-4 | Access pool and which seats are access-only (4) | No pool state. Access-only is a seat property, and any access feature makes a seat access-only (concern 3).                                                                                                                               |
| H-5 | Access-need category (5)                        | Categories reuse the access-feature list (as in intent 2's F-4). Any category is accepted for any access seat. It's stored apart and deleted when the hold ends (concerns 4 and 6).                                                       |
| H-6 | Companion rules (6)                             | Only the seat linked to that access seat, held in the same hold, one per access seat. A companion can never be held on its own.                                                                                                           |
| H-7 | Outbox design (7)                               | Poll every 500 ms, batches of 100, `SKIP LOCKED`, backoff capped at 30 s. Published rows and ended holds are deleted after 7 days. Lag is logged per expiry; there's no dashboard yet. No target is gated in CI beyond AC 16 (≤ 5 s lag). |
| H-8 | Clock source (8)                                | The database `expires_at` and `now()` decide. The Temporal timer is only the trigger. Reads and lazy expiry follow `expires_at`.                                                                                                          |
| H-9 | Deployed environments (9)                       | Local and CI only. Nothing deploys API or worker hosting yet, and concern 8 blocks a public deploy anyway. Temporal Cloud stays unused until then.                                                                                        |
