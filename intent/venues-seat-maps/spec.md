# Spec: venues, events and seat maps (read-only admin)

Status: approved
Intent: [intent.md](intent.md)
Date: 2026-10-05

## Goal

Give Boxoffice its first domain model (venues as tenants, seat-map layouts
with reserved seats and general-admission areas, access and companion seats,
events with performances), load it from invented seed data, and let venue
staff browse it in a read-only, WCAG 2.2 AA admin. Later intents (holds,
sales, the reservation engine) extend this model rather than replace it.

## Non-goals

- Creating, editing or deleting anything through a UI or API; seating-plan
  import.
- Customer pages in `apps/web`; prices and price tiers; holds, sales,
  reservations and per-performance seat availability.
- Sign-in, roles, permissions; a platform-staff cross-venue view.
- `packages/domain/reservation` and `packages/domain/money.ts` (nothing here
  changes seat state or touches money).
- Deploying admin anywhere reachable from the internet.

## Design

### Where each part lives

| Layer                | Adds                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`    | Types and pure invariant checks for venue, layout, section, row, seat, GA area, access features, companion links, event, performance. No I/O.                           |
| `packages/db`        | Drizzle schema for those tables, one migration generated with `pnpm db:new venues-seat-maps`, read queries that always take a `venueId`, and an idempotent seed script. |
| `packages/contracts` | Zod response schemas for the read endpoints.                                                                                                                            |
| `apps/api`           | Read-only endpoints under `/venues`. Gains a `DATABASE_URL` dependency on `packages/db`.                                                                                |
| `apps/admin`         | Server-rendered pages that call the API (`API_URL`), with a seat-map view (SVG) and an equivalent table.                                                                |

The admin reads through the API, not the database, so tenant scoping and
the contracts are enforced and tested in one place.

### Tenancy

- `venue` is the tenant. Every venue-owned table has a non-null `venue_id`.
  Child tables use composite foreign keys `(venue_id, parent_id)`, so a row
  can't reference a parent from another venue.
- Every query function in `packages/db` takes `venueId` as a required
  argument. No exported query can read venue-owned rows without one.
- An ID that exists under another venue returns 404, exactly as if it didn't
  exist.

### Seat-map model

- **Layout:** belongs to a venue and has a name. It contains sections, each
  section contains either rows of seats (reserved) or is a GA area with a
  capacity (an integer ≥ 1).
- **Seat:** has a row label and a seat label, unique within its section. It
  carries a position (`x`, `y`, see below), zero or more **access features**
  from a fixed list, and an optional link to the access seat it serves as a
  **companion**.
- **Companion link:** one companion seat per access seat (A11Y-9). Both
  seats must be in the same layout and section. Adjacency is declared by the
  link, not computed, because wheelchair spaces often have no neighbouring
  row seats.
- **Positions:** integer `x`, `y` in layout units, origin top-left, `y` grows
  downward. One unit is one seat pitch. The renderer scales to fit, and a
  future importer or editor writes the same units (F-3).
- **Event:** belongs to a venue and has a name, a slug and a description,
  plus the extra fields in F-7. It has one or more **performances**, each
  with a start time and a layout (F-1).
- **Times:** stored as UTC `timestamptz`. Each venue has an IANA time zone,
  `Europe/London` for all seed venues. Admin shows times in the venue's zone
  (F-6).

### Seed

- `pnpm db:seed` is a new root script. It runs `runMigrations`, then
  upserts the seed by stable natural keys, so running it twice changes
  nothing.
- Seed venues are invented (GDPR-8 style names, no real places):
  - a 300-seat studio with GA standing;
  - a 1,200-seat theatre with stalls, circle and boxes;
  - a 5,000-seat arena with mixed reserved and GA (F-2).

  Each has access seats with features and linked companion seats.

- Seed data passes the domain invariants before it is written. Invalid seed
  data fails the script and writes nothing.

### Admin pages

- `/` lists venues. This is a dev-only venue picker until sign-in exists
  (F-5).
- `/venues/[venueId]` shows the venue, its layouts and its events.
- `/venues/[venueId]/events/[eventId]` lists the event's performances, with
  times and layouts.
- `/venues/[venueId]/layouts/[layoutId]` is the seat map:
  - **Map:** an SVG of sections, seats and GA areas.
    - Seat type and access features are shown by shape or icon plus text
      label, with a legend (A11Y-4).
    - Zoom in, zoom out and reset are buttons. Nothing needs drag, pinch or
      a precise pointer (A11Y-3).
    - The map is marked as an image with a text summary, and it points to
      the table.
  - **Table:** sections → rows → seats, with access features and companion
    links, carrying everything the map shows (A11Y-3). GA areas are listed
    with their capacity. For the 5,000-seat layout the table is grouped by
    section with headings, not one flat table.

Every page has `lang="en-GB"`, a title, one `<h1>`, landmarks and visible
focus. Pages work at 320 CSS px and 200% text (A11Y-7).

## Acceptance criteria (testable)

**Model and data**

1. `pnpm db:new venues-seat-maps` produces the only new migration, and
   `pnpm db:check` passes. No hand edits under `packages/db/migrations`.
2. Domain invariants reject each of the following (unit tests):
   - a duplicate seat label in a row;
   - a GA capacity below 1;
   - a companion link to a seat in another section or layout;
   - two companions linked to one access seat;
   - an access feature outside the fixed list;
   - a performance referencing another venue's layout.
3. `pnpm db:seed` against an empty database creates the three seed venues
   with their layouts, access seats, companion links, events and
   performances. Running it a second time leaves row counts unchanged
   (integration test).
4. Seed and fixture files contain no real venue names, people or addresses.
   This extends the existing repo hygiene test.

**API (integration, Testcontainers Postgres, seeded)**

5. `GET /venues` returns the venue summaries. `GET /venues/:venueId`,
   `/venues/:venueId/events`, `/venues/:venueId/events/:eventId` and
   `/venues/:venueId/layouts/:layoutId` return bodies that parse with their
   contracts.
6. Tenant isolation: requesting an event or layout ID that belongs to venue B
   under venue A's path returns 404 with the same body as a missing ID.
7. Unknown IDs and malformed IDs return 404 and 400 respectively; neither
   returns 500.
8. The 5,000-seat layout endpoint responds in under 1 s on CI and returns
   every seat. Its JSON stays under 1 MB.
9. Every `packages/db` read function requires `venueId`. A unit test asserts
   that each exported query function's signature has it; there is no
   unscoped read export.

**Admin (unit with jsdom + integration in a browser)** 10. Each of the four admin pages renders with seed data, with no serious or
critical axe violations. The seat-map page passes this both with the map
and with the table expanded (A11Y-11). 11. A keyboard-only test opens admin and: - picks the 1,200-seat venue; - opens its layout; - zooms the map in and out with the buttons; - reaches a named access seat and its companion in the table.

    It uses only Tab, Shift+Tab, Enter, Space and the arrow keys, and focus
    is visible at every step (A11Y-2, A11Y-11).

12. Access seats are distinguishable in the map without colour. A test
checks that each access seat's SVG element has a non-colour marker
(shape or icon) and an accessible name that includes its features
(A11Y-4). 13. Every seat in a layout appears in the table, with the same
section/row/seat labels, access features and companion relation as the
map. A test compares the map and table data sets (A11Y-3). 14. At a 320 px viewport, the seat-map page has no horizontal scroll of the
page itself and the table is reachable (A11Y-7, browser test). 15. If the API is unreachable, each admin page shows an error page with a
heading and a retry link, not a blank page or a stack trace.

**Repo** 16. `.env.example` gains `API_URL` (admin) and keeps `DATABASE_URL`. The
existing env-example test passes. 17. CI stays green on all five required checks.

## Data model impact

These tables are new, all in the default schema. Every table except `venue`
has a `venue_id`.

| Table                 | Key columns                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `venue`               | `id`, `name`, `slug` (unique), `time_zone`                                                                        |
| `layout`              | `id`, `venue_id`, `name`                                                                                          |
| `section`             | `id`, `venue_id`, `layout_id`, `name`, `kind` (`reserved` \| `ga`), `ga_capacity` (null unless `ga`)              |
| `seat`                | `id`, `venue_id`, `section_id`, `row_label`, `seat_label`, `x`, `y`; unique `(section_id, row_label, seat_label)` |
| `seat_access_feature` | `venue_id`, `seat_id`, `feature` (enum)                                                                           |
| `companion_link`      | `venue_id`, `access_seat_id` (unique), `companion_seat_id` (unique)                                               |
| `event`               | `id`, `venue_id`, `name`, `slug` (unique per venue), `description`, plus F-7 fields                               |
| `performance`         | `id`, `venue_id`, `event_id`, `starts_at` (timestamptz), `layout_id`                                              |

IDs are UUIDs. Composite foreign keys enforce same-venue references. No
personal data is stored, and nothing stores or computes money.

## Interfaces

**HTTP API (read-only, JSON, Zod contracts in `packages/contracts`)**

| Method + path                            | 200 body                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /venues`                            | `VenueSummary[]` (dev-only picker; see F-5)                                       |
| `GET /venues/:venueId`                   | `VenueDetail` (layouts and events, summarised)                                    |
| `GET /venues/:venueId/events`            | `EventSummary[]`                                                                  |
| `GET /venues/:venueId/events/:eventId`   | `EventDetail` with `PerformanceSummary[]`                                         |
| `GET /venues/:venueId/layouts/:layoutId` | `LayoutView`: sections, rows, seats (`x`, `y`, features, `companionOf`), GA areas |

- Errors are `{ "error": "not_found" | "bad_request" | "unavailable" }`,
  with no internals.
- `/health` is unchanged and stays independent of the database.

**Commands**

- `pnpm db:seed` (new).
- `pnpm db:new venues-seat-maps` (once, during implementation).

**Env**

- `api`: `DATABASE_URL` (now read at startup, Zod-validated).
- `admin`: `API_URL` (default `http://localhost:4000`).

**Admin routes:** as listed under Design.

## Failure modes

| Failure                         | Behaviour                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Seed run twice, or interrupted  | Upserts by natural keys in one transaction: a rerun is a no-op, and an interrupted run leaves nothing half-written.   |
| Seed data breaks an invariant   | Script exits non-zero, names the venue and rule, writes nothing.                                                      |
| Cross-venue ID in a path        | 404, same as missing (no existence leak across tenants).                                                              |
| DB down at API startup          | API logs the DB host (never the URL with credentials) and exits non-zero.                                             |
| DB drops while running          | The request returns 503 `unavailable`; `/health` stays 200 (liveness only).                                           |
| API down when admin renders     | Accessible error page with heading and retry (AC 15).                                                                 |
| Very large layout               | Grouped table, map scaled with zoom buttons; AC 8 bounds response time and size.                                      |
| DST change between performances | Times stored in UTC, shown in the venue zone; a seed performance on a clock-change date is checked in the unit tests. |

## End-to-end verification step

1. Run `pnpm install --frozen-lockfile`, then `pnpm typecheck`, `pnpm lint`,
   `pnpm test` and `pnpm db:check`.
2. Run `pnpm test:int`. It covers the migration and seed, the API tenant
   isolation, and the admin axe and keyboard browser tests.
3. Locally, run `docker run` Postgres, then `pnpm db:seed`, start `api` and
   `admin`, and open `http://localhost:3001`. Then:
   - Pick "the 1,200-seat theatre" and open its layout.
   - Using only the keyboard, zoom the map and find an access seat and its
     companion in the table.
   - Run an axe browser extension pass.
4. Open the PR. All five CI checks pass.

## Flagged concerns

1. **A11Y-3/A11Y-7: a 5,000-seat map can't be usable at 320 px on its own.**
   → The table is the full equivalent, grouped by section. The map scales
   down and zooms with buttons. AC 13 and AC 14 test that nothing is lost.
   Owner to confirm this pairing meets the bar for staff use.
2. **A11Y-11: the keyboard-only test needs a real browser.** The repo has
   none. → Recommend Playwright (Chromium only), run inside
   `pnpm test:int`, adding about 1–2 min to the `integration` job. jsdom +
   `axe-core` covers the axe checks in unit tests. This adds two new dev
   dependencies; owner to approve.
3. **A11Y-9: companion adjacency.** "Seated next to the access seat" isn't
   computable for wheelchair spaces with no row neighbours. → Adjacency is
   declared by an explicit link, restricted to the same section, one
   companion per access seat (AC 2). Owner to confirm "same section" is
   tight enough.
4. **Dev-only venue list vs. the intent's tenant model.** Without sign-in,
   staff need a way to choose a venue. `GET /venues` and the admin home page
   list every venue, which is a cross-venue view the intent puts out of
   scope. → Kept as a dev-only picker, documented as such. Admin must not be
   deployed until the auth intent replaces it (see F-5).
5. **Intent: "admin must not be reachable with real data on a public URL".**
   `deploy.yml` already builds and pushes an admin image on every PR and
   push to `main`, but nothing deploys it. → No change now. The future
   staging deploy must exclude admin, or require auth, until the auth intent
   lands. Owner to note it for the deploy intent.
6. **`apps/api` gains a database dependency.** Until now the API had no
   `DATABASE_URL`. → It is read and validated at startup; `/health` stays
   database-free. The api Docker image needs the env at runtime (no default
   in production).

## Decisions (owner, 2026-10-05)

The owner accepted every recommendation below and in Flagged concerns 1–6
(table-plus-scaled-map for large layouts; Playwright, Chromium only, in
`pnpm test:int`; explicit same-section companion links; dev-only venue
picker; admin never deployed before auth; API reads `DATABASE_URL`).

| #   | Question                             | Recommendation                                                                                                                                                                                                                                                          |
| --- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | Layout per event or per performance? | **Per performance.** Seat state will be per performance in holds and sales anyway. The seed gives every performance of an event the same layout, so admin behaves as "per event" today. This departs from the intent's "an event uses one layout", so it needs your OK. |
| F-2 | Seed scale and render target         | Include a 5,000-seat arena. Target: the layout API responds in under 1 s and is under 1 MB (AC 8), and the admin map renders in under 2 s on a mid-range laptop (measured manually in E2E step 3, not gated in CI).                                                     |
| F-3 | Seat coordinate system               | Integer `x`, `y` layout units, origin top-left, one unit per seat pitch.                                                                                                                                                                                                |
| F-4 | Access-feature list                  | `wheelchair_space`, `transfer_seat` (move from wheelchair to seat), `step_free`, `aisle`, `extra_legroom`, `hearing_loop`, `near_exit`. The later declared-need categories (A11Y-8) map onto these.                                                                     |
| F-5 | Where admin runs before auth         | Local and CI only; never deployed. The venue picker stays dev-only (concern 4).                                                                                                                                                                                         |
| F-6 | Times and zones                      | UTC storage plus a per-venue IANA zone, `Europe/London` for all seed venues.                                                                                                                                                                                            |
| F-7 | Extra event fields now               | `running_time_minutes`, `age_guidance` (short text), and per-performance access tags `relaxed`, `captioned`, `bsl_interpreted`, `audio_described`. Nothing else until a feature needs it.                                                                               |
