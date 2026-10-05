# Intent: venues, events and seat maps (read-only admin)

Status: draft
Originator: repo owner
Date: 2026-10-05

## Problem

The skeleton runs, but Boxoffice has no domain data. There are no venues,
events, performances or seat maps, so:

- Nothing later in the roadmap has anything to act on: holds (intent 3),
  sales (4) and the reservation engine (5) all need seats and performances.
- Venue staff can't see what a venue's seating looks like in the product,
  and there's no shared vocabulary in the code for sections, rows, seats,
  general-admission areas or access seats.
- `apps/admin` is a placeholder page, so the admin UI pattern, and how it
  meets WCAG 2.2 AA (policy-accessibility, `decisions/0004`), hasn't been
  set.
- The tenant boundary (one venue's data never mixed with another's, GDPR-1)
  exists only as a policy, not in the data model.

This is the brief's intent 2: the first data model and the first real UI.

## Proposed outcome

Seed data and a read-only admin view of venues, events and seat maps, built
on a data model that later intents extend rather than replace.

**Data model**

- **Venue** is the tenant. Every venue-owned row carries its venue, and
  every read is scoped by venue.
- **Layouts:** a venue has one or more named seat-map layouts (e.g. "All
  seated", "Standing stalls"). An event uses one layout.
- A layout contains **reserved seating** (sections → rows → seats, with
  positions for drawing the map) and/or **general-admission areas** with a
  capacity.
- **Access seats:** seats can be flagged by access feature (e.g. wheelchair
  space, step-free), and companion seats are linked to the access seats they
  serve (A11Y-9, `decisions/0002`). Booking rules for them come later.
- **Event → performances:** an event (a show or production) has one or more
  dated performances.
- Changes go through `packages/domain`; migrations are generated with
  `pnpm db:new`.

**Seed data**

- A seed script loads a few invented venues (different sizes and layouts,
  reserved and GA, with access and companion seats), events and
  performances. Nothing is created or edited through the UI in this intent.

**Read-only admin (`apps/admin`)**

- Venue staff can browse venues, their events and performances, and view a
  layout.
- A seat map view shows the layout visually, with an equivalent accessible
  table of seats (A11Y-3). Seat types and access features are shown by more
  than colour (A11Y-4). The whole flow works with the keyboard alone.

## Affected users and systems

- **Venue box-office staff:** the people who browse venues, events and seat
  maps in admin. There is no sign-in yet (see Constraints).
- **Later intents:** holds, sales, the reservation engine and the scanner
  all build on this model.
- **Code:** `packages/domain` (venue, layout, seat, event, performance
  types), `packages/db` (schema, generated migrations, seed), `packages/contracts`
  (read APIs), `apps/api` (read endpoints), `apps/admin` (views).

## Constraints

- **Read-only:** no create, edit or delete in any UI or API. Data comes from
  the seed script.
- **Tenant model now, auth later.** Every query is scoped by venue, but there
  is no sign-in. Admin must therefore not be reachable with real data on a
  public URL until an auth intent lands.
- **Accessibility:** admin meets WCAG 2.2 AA (`decisions/0004`), with a
  visual map plus a table alternative, no colour-only state, keyboard-only
  use, zoom and reflow, and axe and keyboard tests (A11Y-1, 2, 3, 4, 7, 11).
- **Fixtures are invented** (CLAUDE.md, GDPR-8): no real venue names,
  addresses or people.
- **No money yet:** no prices or price tiers. `packages/domain/money.ts`
  isn't needed until pricing.
- **Seat changes go through `packages/domain/reservation` once it exists.**
  This intent only reads seats, so it doesn't create that package.

## Out of scope

- Creating or editing venues, events, layouts or seats; seating-plan import.
- Customer-facing pages in `apps/web` (listings, public seat map).
- Prices and price tiers (intent 6), holds (3), sales (4), reservations (5),
  per-performance seat availability.
- Sign-in, roles and permissions.
- A cross-venue view for Boxoffice platform staff.
- Scanner changes.

## Open questions

1. **Layout per event or per performance?** Can different performances of
   the same event use different layouts (e.g. a seated matinee and a
   standing evening show)?
2. **Seed scale:** should the seed include a venue at the top of the target
   range (about 5,000 seats) to prove the seat map renders and stays usable
   at that size? What is acceptable render time?
3. **Seat positions:** what coordinate system and units do seat positions
   use, so a future seating-plan importer or editor can produce them?
4. **Access feature categories:** what is the fixed list (wheelchair space,
   step-free, aisle, hearing loop, ...)? It should match the access-need
   categories customers declare later (A11Y-8, GDPR-4).
5. **Where admin runs before auth:** local only, or also a deployed preview
   with seed data? If deployed, what keeps it from being public?
6. **Times and time zones:** are performance times stored in UTC and shown
   in Europe/London, or are all venues assumed to be UK?
7. **Event fields:** beyond name, description and performances, which event
   fields are needed now (e.g. age guidance, running time, access
   performances such as relaxed or captioned shows)?
