# Intent: holds with Temporal timers (create, expire, release)

Status: draft
Originator: repo owner
Date: 2026-10-06

## Problem

Intent 2 (#11) gives Boxoffice venues, layouts, seats and performances,
but nothing can be held. So:

- GA sales (intent 4) and the reservation engine (5) have nothing to build
  on. A buyer needs seats or GA places set aside while they pay, and those
  places must come back on their own if the buyer leaves.
- Boxoffice has no running workflow. `apps/worker` hosts an empty Temporal
  worker, so timers, retries, and how the API and worker hand off work
  haven't been tried yet.
- There is no outbox. If the database commit succeeds and the Temporal call
  fails (or the reverse), a hold can end up never expiring, or a timer can
  fire for a hold that doesn't exist.
- `packages/domain/reservation` doesn't exist, although CLAUDE.md says every
  reservation change has to go through it.
- The access-seat rules (A11Y-8, 9, 10) and hold timers (A11Y-5) exist only
  as policy; no code enforces them yet.

This is the brief's intent 3: the first workflow, and the first use of the
outbox.

## Proposed outcome

Checkout holds on a performance's reserved seats and GA capacity. Holds are
created, extended and released through the API, expire on a Temporal timer,
and show in the admin seat map.

**Holds**

- A hold is for one performance and covers specific reserved seats, a
  quantity in a GA area, or both.
- Creating a hold returns an **opaque hold token**. Only that token can
  extend or release the hold. Holds store no personal data.
- A hold lasts a **fixed default length**. An **extend** operation resets
  the timer, up to a cap of at least ten extensions (A11Y-5). Hold length
  isn't configurable per venue yet.
- A hold ends in one of two ways: it is **released** (by token) or it
  **expires** (by timer). Either way the seats or GA places become available
  again.
- **No double holds:** a seat has at most one active hold, and active GA
  holds never exceed the area's capacity. Simple database constraints enforce
  this. Intent 5 hardens it under contention.
- All hold changes go through a new `packages/domain/reservation`.

**Access and companion seats**

- An access seat can be held only if the hold carries a declared access-need
  category (A11Y-8). Nothing is checked beyond the category.
- One companion seat linked to that access seat can be held with it, in the
  same hold (A11Y-9).
- When such a hold expires or is released, the seats go back to the access
  pool, never to general sale (A11Y-10, `decisions/0003`).

**Outbox and workflow**

- A hold write and its `hold.created` outbox event commit in one
  transaction.
- A relay reads the outbox and starts or signals the hold's Temporal
  workflow. A crash between the database and Temporal can't lose an expiry,
  and repeated delivery is harmless.
- The workflow waits for the timer and expires the hold. It handles extend
  and release, and writes `hold.extended`, `hold.released` and
  `hold.expired` events back to the outbox for later consumers (sales,
  email, finance).

**Admin view**

- The admin seat map and seat table for a performance show which seats are
  held and how many GA places are held. They stay read-only. Held state
  uses text or icon as well as colour (A11Y-4).

## Affected users and systems

- **Buyers (later):** they won't use holds until intent 4 adds a customer
  flow. This intent shapes their checkout experience (hold length,
  extensions, access seats).
- **Venue box-office staff:** they see held seats and GA counts in admin.
  They can't create or release holds from admin.
- **Later intents:** GA sales (4) turn holds into orders. The reservation
  engine (5) hardens hold creation under load. Outbox consumers (email,
  finance) subscribe to hold events.
- **Code:** `packages/domain/reservation` (new), `packages/db` (holds and
  outbox tables, generated migrations), `packages/contracts` (hold API),
  `apps/api` (hold endpoints, outbox writes), `apps/worker` (relay, hold
  workflow), `apps/admin` (held state on the seat map and table).
- **Infrastructure:** first real use of Temporal locally (`pnpm temporal:dev`),
  in CI (Testcontainers) and in deployed environments (Temporal Cloud).

## Constraints

- **Checkout holds only.** Staff allocations (press, sponsor, house seats)
  are a separate intent.
- **API only for writes.** No customer UI. Admin stays read-only and
  local-only before auth, as in intent 2.
- **No personal data on holds.** The hold token isn't linked to a person.
  The access-need category is the only sensitive field (see open
  question 5).
- **Reservation changes go through `packages/domain/reservation`.** Never
  update seats directly (CLAUDE.md).
- **Migrations only via `pnpm db:new`.**
- **Simple safety, not the reservation engine.** Constraints prevent double
  holds. `SELECT ... FOR UPDATE SKIP LOCKED`, property tests and the k6 soak
  gate belong to intent 5.
- **Accessibility:** A11Y-5 (extension cap ≥ 10), A11Y-8/9/10 (access and
  companion seats), A11Y-4 and A11Y-11 (admin held state: no colour-only
  state, axe and keyboard tests).
- **No money yet:** holds carry no prices.

## Out of scope

- Staff allocations and manual staff release of access seats (A11Y-10's
  "only venue staff release them" needs a staff action, which comes later).
- Orders, payments and confirmation emails (intent 4).
- Customer pages, countdown UI and the 20-second warning (A11Y-5's UI
  side), all in intent 4.
- Contention hardening, soak tests and oversell alerts (intent 5).
- Per-venue hold length, waitlists, price tiers.
- Outbox consumers other than the hold workflow.
- Sign-in, roles, and rate limiting or abuse protection on the hold API.

## Open questions

1. **Hold length and extension:** what is the default length (e.g. 10
   minutes)? How long does each extension add? What is the cap (≥ 10)?
   Is there an overall maximum lifetime?
2. **Hold size limits:** what are the most seats or GA places one hold can
   take? Can one hold mix reserved seats from different sections, or
   reserved seats and GA?
3. **Partial availability:** if some requested seats are already held, does
   the whole request fail, or are the free seats held?
4. **Access pool after expiry:** in this intent, does "back to the access
   pool" just mean the seat is free again but still access-only? Or is there
   a separate pool state to model now?
5. **Access-need category on a hold:** it's health data (GDPR-4) once
   intent 4 ties a hold to a buyer. Is it stored on the hold, kept apart, or
   only checked at hold time and dropped? How long are expired and released
   holds and their events kept (GDPR-3)?
6. **Companion seat rules:** must the companion seat be one of the seats
   linked to that access seat, or any seat next to it? Can a companion seat
   be held without its access seat?
7. **Outbox design:** how does the relay poll (interval, batch), and what
   lag between commit and workflow start is acceptable? How long are sent
   outbox rows kept? Does this intent add a "hold-expiry lag" metric (brief
   §3 dashboard), or is that left for later?
8. **Clock source:** what counts as the expiry time, the Temporal timer or a
   stored `expires_at`? What happens to a request that arrives just as the
   hold expires?
9. **Deployed environments:** should holds run on preview/staging with
   Temporal Cloud now? Or locally and in CI only until a customer flow
   exists?
