---
name: policy-accessibility
description: Accessibility (WCAG 2.2 AA) and access-seating constraints for Boxoffice. Use when designing, speccing or reviewing anything a person sees or operates — customer pages, seat maps and seat selection, checkout and countdown timers, on-sale queues, emails, tickets, the admin app or the door scanner — and whenever a feature touches access seats, wheelchair spaces, companion or carer tickets, or how access seating is allocated, priced or released, even if the request never says "accessibility". Not for backend-only work (APIs, jobs, migrations, CI, infrastructure) with no UI and no access-seat rules.
---

# Accessibility policy

Disabled customers must be able to find, choose, buy and use tickets on their
own, and venues must be able to keep access seating for the people who need
it. Under the Equality Act 2010 venues owe disabled people reasonable
adjustments; every rule below is how the platform makes that the default.

## Rules

- **A11Y-1 WCAG 2.2 AA is the bar** for every customer-facing surface: pages,
  seat maps, checkout, emails, PDF and wallet tickets, error pages. The admin
  app and scanner meet it too; a spec that can't flags the gap for the owner.
- **A11Y-2 Keyboard-only purchase.** Find an event, pick seats, pay and reach
  confirmation with the keyboard alone: logical focus order, visible focus
  never hidden by sticky bars or banners, no traps (including in and out of
  the Stripe Payment Element).
- **A11Y-3 Seat maps have an equal alternative.** A list or table of
  available seats (area, row, seat, price, access features) lets customers
  find, compare and select seats as fully as the map does. Nothing needs dragging, pinch or a precise pointer, and
  pointer targets are at least 24×24 CSS px, or the list is the way in.
- **A11Y-4 No colour-only state.** Availability, selection, holds, price
  tiers, access seats, errors and scanner valid/invalid results also use
  text, icon, shape or pattern. Text contrast 4.5:1; seat markers, focus
  rings and other UI parts 3:1.
- **A11Y-5 Time limits can be extended.** Seat-hold and checkout countdowns
  warn at least 20 seconds before expiry and let the customer extend with one
  action, at least ten times. Announce the timer at milestones, not every
  second. If an extension would clash with on-sale fairness or hold rules in
  `packages/domain/reservation`, flag it for the owner; never just drop it.
- **A11Y-6 Errors and changes are announced.** Field errors are in text,
  tied to the field, with a fix suggested; status changes (seat taken, hold
  expired, payment failed) reach screen readers via live regions. Queues and
  sign-in have no puzzle CAPTCHA without an accessible alternative, and never
  ask again for details already given in the same flow.
- **A11Y-7 Zoom and reflow work.** Pages work at 320 CSS px wide and 200%
  text size with no loss of content or function; zoom is never disabled.
  Pages declare `lang="en-GB"`, a title, one `<h1>` and landmarks.
- **A11Y-8 Access seats are self-declared.** The booker picks the access need
  from set categories (see GDPR-4); no proof, no documents, no free-text
  medical questions. Access seats are sold only to bookings that declare a
  need, through the same flow as other seats, and never cost more than
  standard seats in the same price zone.
- **A11Y-9 One free companion seat.** Every access booking can add one free
  companion ticket, seated next to the access seat, in the same order. The
  seat model links companion seats to their access seats.
- **A11Y-10 Access seats never auto-release.** Unsold access and companion
  seats stay reserved up to the event, and expired holds on them return to
  the access pool, not general sale. Only venue staff release them, per
  event and per seat, recorded in the audit log.
- **A11Y-11 Prove it in tests.** Each UI acceptance criterion includes an
  automated axe check with no serious or critical violations, and the main
  path of the feature has a keyboard-only test.

Owner decisions behind these rules: A11Y-1 (`decisions/0004`), A11Y-8
(`decisions/0001`, `0005`), A11Y-9 (`decisions/0002`), A11Y-10
(`decisions/0003`). Changing one of those rules needs a new decision record.

## Applying this in a spec or review

For each rule the design touches, add a line under **Flagged concerns**:
`A11Y-n: <what in the intent/design conflicts or needs care> → <how the spec
handles it>`. If the intent asks for something a rule forbids (proof of
disability, releasing access seats automatically, a drag-only seat picker),
flag it and leave the decision to the owner; never quietly redesign around
it. Flag a rule only when the intent or your design actually does what it
governs; don't list rules or WCAG criteria to show they were considered. If
the feature has no UI and doesn't touch access seating, say nothing about
accessibility.
