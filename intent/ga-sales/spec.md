# Spec: GA sales with Stripe test mode and confirmation email

Status: approved
Intent: [intent.md](intent.md)
Date: 2026-10-07

## Goal

A member of the public can buy general-admission (GA) places for a
performance in `apps/web`, pay in Stripe test mode and receive an order
confirmation email. A paid hold becomes an order, and its places count as
**sold**. A webhook delivered twice, out of order or late can't sell a
place twice or charge without a result. Admin shows sold and held GA counts.
This is Boxoffice's first customer UI, first payment flow, first stored
personal data and first outbox consumers beyond the hold workflow.

## Non-goals

- Selling reserved seats (intent 5). The holds API still holds them, but
  checkout refuses a hold that contains any.
- Price tiers, discounts, promo codes, waitlists (intent 6).
- Customer-requested refunds, exchanges, cancellations (intent 7). The only
  refund here is the automatic one for a late payment that can't be
  fulfilled.
- Scannable tickets, QR codes, wallet passes (intent 9).
- Buyer accounts, sign-in, order history, named attendees, resend-email UI.
- Admin price editing, admin sales actions, staff auth.
- GDPR export and erasure tooling (intent 10); see concern 12.
- A real email provider. Mail goes to Mailpit everywhere in this intent
  (G-4).
- Production, live keys, on-sale queues, rate limiting, bot protection.
- Hosting on Fly (G-1): the next intent, hosted preview and staging.

## Design

### Where each part lives

| Layer                | Adds                                                                                                                                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`    | `src/money.ts` (new): a branded integer `Pence` and the only arithmetic on amounts. `reservation` gains the `purchased` hold status, the GA companion rule and consent check. `src/orders/` (new, pure): order state machine, line pricing, order reference format, terms template and version.           |
| `packages/db`        | One migration via `pnpm db:new ga-sales`. `holds.ts` stays the only writer of hold tables and `ga_inventory` and gains `purchaseHold` and `sellGaPlaces`. New `orders.ts` is the only writer of order, payment, Stripe-event and buyer tables. The outbox insert moves to `outbox.ts` so both can use it. |
| `packages/contracts` | Zod schemas for prices/offer, checkout, order view, the webhook ack, and the extended hold and availability shapes.                                                                                                                                                                                       |
| `apps/api`           | Offer, checkout and order-view endpoints; `POST /webhooks/stripe`; `Idempotency-Key` on hold create. A `PaymentGateway` port with a Stripe implementation (and a fake injected only by tests).                                                                                                            |
| `apps/worker`        | Relay dispatch for order events. Workflows: `orderConfirmationWorkflow`, `checkoutCleanupWorkflow`, `lateRefundWorkflow`. An SMTP mailer. Housekeeping gains the GDPR-3 retention steps.                                                                                                                  |
| `apps/web`           | The first customer pages: venue → performance → GA section and quantity → checkout (countdown, terms, embedded Stripe Checkout) → confirmation.                                                                                                                                                           |
| `apps/admin`         | GA areas show "N sold, M held of C".                                                                                                                                                                                                                                                                      |

### Prices (G-6)

- Each GA section of a performance has one `ga_price` row: `face_pence`
  and `fee_pence` (a per-place booking fee, which may be 0). The **total**
  `face + fee` is the only headline figure. The breakdown ("includes £2.50
  booking fee") is shown next to it, never added later (UKR-6,
  `decisions/0009`).
- A GA section with no price row isn't on sale. The web shows it as "Not on
  sale" and checkout refuses it.
- Prices are set by seed data and by a `packages/db` function used in
  tests. **No price-setting HTTP endpoint**, because the API has no auth
  (concern 3).
- The seed prices every GA section of every seeded performance with an
  invented price and a non-zero fee.

### Inventory: sold places

- `ga_inventory` gains `sold`, with `CHECK (sold >= 0 AND held + sold <=
capacity)`. Hold create now succeeds only when `held + sold + n <=
capacity`.
- Availability reports `sold` per GA section from `ga_inventory` (0 if the
  row doesn't exist), next to `held` from live hold lines.
- `remaining = capacity − held − sold`, never below 0.

### Hold changes

- **New terminal status `purchased`:** `active → purchased` happens only in
  the payment-confirmed transaction (`purchaseHold`). In that transaction,
  GA lines end, `held −= n` and `sold += n` per section, and `hold.purchased`
  goes to the outbox. The relay signals `released` to `holdWorkflow` so it
  ends early.
- **Idempotent create (holds concern 9, G-10):** `POST .../holds` accepts an
  optional `Idempotency-Key` (22–64 base64url chars).
  - With a key, the token is `base64url(HMAC-SHA256(HOLD_TOKEN_SECRET,
venueId ":" key))` instead of random bytes, and the key's hash is stored
    on the hold (unique per venue).
  - Repeating the same key with the same body returns 201 with the same
    `holdId` and token while the hold is active. After it ends, it returns
    409 `hold_ended`. The same key with a different body returns 422
    `idempotency_mismatch`.
  - Without a key, behaviour is unchanged.
- **GA companion place (G-3, recommended option):** a GA line may carry
  `companion: { accessNeed }`. That holds one extra free place in the same
  section, which counts against capacity but not against the 10-place limit.
  One companion per hold (A11Y-9). It needs a declared category from the
  existing list (A11Y-8, H-5) and is stored in `hold_access_need` with
  `section_id` instead of `seat_id`.
- **Consent (holds concern 6, GDPR-4):** any request carrying an
  `accessNeed` (seat or GA) must include `accessNeedConsent: "<version>"`
  matching the current consent text version. Otherwise it returns 422
  `invalid_hold` with rule `access_need_consent_missing`. The web collects
  the consent with an unticked checkbox and a short purpose statement.

### Orders

- **One order per hold.** An order is created by **starting checkout** on an
  active hold that holds only GA lines, all priced, for a performance that
  hasn't started.
- **Lines:** one per GA section, with `quantity`, `unit_face_pence` and
  `unit_fee_pence` copied from `ga_price` at checkout, plus a companion line
  at £0 face and £0 fee if present. `total_pence` is the sum, computed only
  in `money.ts`.
- **Reference:** `BX-` plus 8 Crockford base32 characters, random and unique
  per venue. This is what the buyer sees.
- **States:**

  | From              | To                | When                                                                    |
  | ----------------- | ----------------- | ----------------------------------------------------------------------- |
  | (new)             | `pending_payment` | Checkout started                                                        |
  | `pending_payment` | `paid`            | Payment confirmed, and the places are bought (hold active, or re-sold)  |
  | `pending_payment` | `expired`         | Checkout session expired, or the hold ended and the session was expired |
  | `pending_payment` | `refund_pending`  | Payment confirmed but the places can no longer be sold                  |
  | `expired`         | `paid`            | A late payment completes and places are still free                      |
  | `expired`         | `refund_pending`  | A late payment completes and places are gone                            |
  | `refund_pending`  | `refunded`        | Stripe refund succeeded                                                 |

  Every transition writes one outbox row in the same transaction:
  `order.created`, `order.paid`, `order.expired`, `order.refund_required`
  or `order.refunded`. Payloads hold IDs and times only, never an email
  or access need.

- **Terms (G-9, UKR-7):** checkout records `terms_version` and the time the
  terms were shown. The terms are a versioned template in
  `packages/domain/src/orders/terms.ts`, filled with the venue name (as
  seller), the event's exchange policy (always "none" until intent 7,
  `decisions/0008`), the cancelled and rescheduled promises (UKR-3, UKR-4)
  and the statement that dated tickets have no 14-day cancellation right
  (UKR-2).
- **Buyer data (G-5, GDPR-2):** the buyer's **email** is the only personal
  field. Stripe Checkout collects it, so the buyer types it once (A11Y-6),
  and we read it from the confirmed session. It's stored in `order_buyer`,
  apart from the order, so pseudonymising it never touches the financial
  record. Name, address and phone from Stripe are never read or stored. No
  Stripe Customer is created (`customer_creation: "if_required"`), so
  erasure has nothing to reach in Stripe beyond the payment itself.
- **Access need on an order:** when checkout starts on a hold with a
  companion, the category and its consent version and time are copied to
  `order_access_need` (apart from the order). It's deleted 30 days after the
  performance, or when the order expires.

### Payment: embedded Stripe Checkout (G-2)

- Card details are entered only in **Stripe Checkout, embedded mode**
  (`ui_mode: "embedded"`). This is the same Stripe-hosted Checkout the owner
  chose, but rendered in Stripe's iframe on our checkout page instead of a
  redirect. Our page keeps the hold countdown and extend button in view
  (A11Y-5), and no card data touches our servers (PCI-1). See concern 1 for
  the redirect alternative.
- **Session:** created by the API at checkout start with:
  - idempotency key `checkout-<orderId>`;
  - `mode: payment`, `payment_method_types: ["card"]` (card and wallets,
    which complete synchronously);
  - one line item per order line, priced in pence;
  - `metadata: { orderId, venueId }`;
  - `return_url` set to the web confirmation page;
  - `expires_at = max(now + 30 min, hold's latest possible end)`, capped at
    24 h. Stripe's minimum is 30 minutes. The **hold** governs in practice:
    when it ends, the session is expired by us.
- **Webhook `POST /webhooks/stripe`:**
  - Verifies `Stripe-Signature` against the raw body with Stripe's
    timestamp tolerance, before any parsing (PCI-3). Anything unverified
    gets 400 and isn't logged beyond the fact.
  - Handles `checkout.session.completed` (with `payment_status = "paid"`)
    and `checkout.session.expired`. Other types get a 200 ack and are
    ignored.
  - Inserts `stripe_event.id` (unique) in the same transaction as the
    effect. A duplicate is a 200 no-op (PCI-4).
  - **Completed:**
    - If the order is `pending_payment` and the hold is still `active`
      (even if just past `expires_at` but not yet ended), it calls
      `purchaseHold` and moves the order to `paid`.
    - If the hold has ended, it lazily expires any overdue holds blocking
      the sections, then tries `sellGaPlaces`. On success, the order
      becomes `paid`; otherwise it becomes `refund_pending`.
    - Either way, it stores the buyer email and the `pi_` ID.
  - **Expired:** `pending_payment → expired`, and the hold is released if
    still active. A completed-then-expired ordering is a no-op.
- **Abandonment:** when a hold with a `pending_payment` order ends
  (`hold.expired` or `hold.released`), the relay starts
  `checkoutCleanupWorkflow(orderId)`. It expires the Stripe session; an
  already-expired session counts as success, and an already-complete one is
  left to the webhook. Then it moves the order to `expired`.
- **Late refund:** `order.refund_required` starts `lateRefundWorkflow`. It
  refunds the full amount to the original payment (idempotency key
  `refund-<orderId>`, UKR-9, UKR-10), moves the order to `refunded`, and
  emails the buyer that the places couldn't be confirmed and the payment
  was refunded.

### Confirmation email (G-4, G-7)

- `order.paid` makes the relay start `orderConfirmationWorkflow(orderId)`
  (workflow ID `order-confirmation-<orderId>`).
- Its activity reads the order and email, renders the email, sends it over
  SMTP and sets `confirmation_sent_at`. If `confirmation_sent_at` is already
  set, it skips. Delivery is at least once: a crash between the SMTP send
  and the update can send a duplicate (concern 9).
- Temporal retries the activity with backoff up to 1 h, for at most 3 days.
  After that, the workflow logs `confirmation_failed` with the `orderId`.
  The order stands either way. There's no resend UI.
- **Content:**
  - venue as seller;
  - event, performance date and time in venue time;
  - section and quantity, with the companion place as "1 companion place
    (free)" and never the access category (GDPR-4);
  - unit total, booking-fee breakdown and order total;
  - reference;
  - the same terms as checkout (UKR-7).
- **Format:** HTML plus plain text. The HTML has `lang="en-GB"`, semantic
  headings, contrast at least 4.5:1, no images carrying meaning, and reads
  in order without CSS (A11Y-1).
- **Transport:** SMTP via `SMTP_URL`. Locally, in tests and (if G-1 deploys)
  in deployed environments, this points at **Mailpit**. No real mail leaves
  any environment in this intent.

### Web purchase flow (`apps/web`)

The web follows the admin pattern: `API_URL`, server-side `fetch` and a
ServiceUnavailable state. The browser never calls the API directly.

1. **`/`** lists venues. **`/venues/[venueId]`** lists upcoming performances
   that have at least one priced GA section.
2. **`/venues/[venueId]/performances/[performanceId]`**
   - Shows each GA section with its **total** price and breakdown, and its
     availability as text: "Available", "Last N places" (when 20 or fewer
     remain) or "Sold out".
   - The buyer picks a quantity from 1 up to `min(10, remaining)`.
   - An optional "I need a free companion place" control reveals the
     access-need category select and the consent checkbox.
   - Submitting runs a server action that creates the hold with an
     `Idempotency-Key` from a hidden form nonce. It stores the hold token in
     an `httpOnly`, `Secure` (outside localhost), `SameSite=Lax` cookie,
     scoped to that hold and never in a URL, then redirects to checkout.
   - A 409 shows "Those places have just gone; N remain" in a live region,
     tied to the quantity field (A11Y-6).
3. **`/venues/[venueId]/checkout/[holdId]`**
   - Shows the order summary with total and breakdown, and the terms block
     (UKR-2, UKR-7).
   - **Countdown (A11Y-5):**
     - Visible remaining time.
     - Polite live-region announcements at 5 min, 2 min, 1 min and 20 s
       remaining, never every second.
     - At least 20 s before expiry, a non-modal alert with an **Extend
       time** button. One activation extends via the server action and
       announces the new time. The button is available at any time while
       extensions remain.
     - The alert doesn't steal focus from the Stripe iframe.
   - Starts checkout (idempotent per hold) and mounts embedded Checkout with
     `STRIPE_TEST_PUBLISHABLE_KEY`.
   - On expiry, it replaces the payment area with "Your time ran out. Your
     places have been released." and a link back to the performance.
4. **`/venues/[venueId]/checkout/[holdId]/complete`** (Stripe's
   `return_url`)
   - Reads the order with the hold-token cookie.
   - Shows "Payment received, confirming…" (polite live region, polling
     every 2 s for up to 30 s), then the reference and summary. The email
     address isn't shown.
   - States `expired` and `refund_pending`/`refunded` have their own text.
5. **All pages:** `lang="en-GB"`, a unique title, one `<h1>`, landmarks,
   visible focus never hidden, working at 320 CSS px and 200% text, no
   colour-only state (A11Y-1, A11Y-4, A11Y-7).

### Admin

- GA areas show "N sold, M held of C" in the visible text, the accessible
  name and the table. Nothing else in admin changes. Admin never shows
  buyer emails, references or access categories.

### Retention housekeeping (GDPR-3)

These steps join the relay's existing housekeeping, run by the scheduled
loop and never by hand:

| Data                                             | Rule                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `order_buyer.email`                              | Pseudonymised (email removed, `pseudonymised_at` set) 2 years after the buyer's last performance at that venue |
| `order`, lines, `payment` for `paid`/`refunded`  | Deleted 6 years after the end of the financial year (31 March, concern 11) of the order                        |
| `expired` orders (no money moved) and their rows | Deleted 7 days after they expired                                                                              |
| `order_access_need`                              | Deleted 30 days after the performance, or with its order                                                       |
| `stripe_event`                                   | Deleted after 30 days (Stripe retries for 3 days)                                                              |

## Acceptance criteria (testable)

**Domain (unit)**

1. `money.ts`:
   - `Pence` values can be made only from safe non-negative integers.
   - `add`, `times(qty)` and `sum` are exact, and throw past
     `Number.MAX_SAFE_INTEGER`.
   - `formatGBP` renders `£0.00`, `£2.50` and `£1,234.05`.
   - A property test (fast-check) checks that a sum of line totals equals
     the order total.
   - A repo test fails if any file outside `money.ts` does `+`, `-`, `*`
     or `/` on an identifier typed `Pence`, using a type-aware lint rule.
2. The order state machine allows exactly the transitions in the table
   above and rejects all others, by name.
3. Reservation rules reject:
   - a GA companion without an access need;
   - a second companion in one hold;
   - any access need without a matching `accessNeedConsent` version.

   A companion place doesn't count towards the 10-place limit. The status
   `purchased` is reachable only from `active`.

4. The terms template contains:
   - the venue name as seller;
   - "no 14-day cancellation" wording for dated events;
   - full refund including fees if cancelled;
   - the keep-or-refund choice if rescheduled;
   - the exchange policy "none".

   A test fails if any terms or UI copy matches `/no refunds/i` (UKR-1).

**Data (integration, Testcontainers Postgres)**

5. `pnpm db:new ga-sales` produces the only new migration, and `pnpm
db:check` passes.
6. **No oversell:** with GA capacity 5, 20 parallel paths fail to push
   `held + sold` above capacity. The paths mix creates of 1 place,
   `purchaseHold` calls and `sellGaPlaces` re-sells. Exactly the expected
   number succeed.
7. `purchaseHold`:
   - ends the hold as `purchased`, moves `n` from `held` to `sold`, and
     writes `hold.purchased` and `order.paid` in one transaction;
   - leaves nothing changed if the transaction fails partway.
8. Only `holds.ts` writes hold tables and `ga_inventory`. Only `orders.ts`
   writes `order`, `order_line`, `order_buyer`, `order_access_need`,
   `payment`, `stripe_event` and `ga_price` (except seed). Only `outbox.ts`
   inserts into `outbox`. The extended writers test enforces all of this.
9. Retention: with the DB clock shifted by a test helper, each row in the
   retention table is pseudonymised or deleted on the next housekeeping run
   and not before.
10. No outbox payload written by the whole test suite contains an email, a
    token, an `Idempotency-Key` or an access category.

**API (integration)**

These tests use a seeded database, a fake `PaymentGateway` and webhooks
signed with the test secret.

11. `GET .../ga-offer` returns each GA section with `facePence`,
    `feePence`, `totalPence = face + fee` and `remaining`. A section without
    a price comes back as `onSale: false`.
12. **Idempotent hold create:**
    - The same `Idempotency-Key` and body twice gives the same `holdId` and
      token, and one hold row.
    - The same key with a different body gives 422 `idempotency_mismatch`.
    - The same key after release gives 409 `hold_ended`.
13. **Checkout start:**
    - Returns 201 `CheckoutStarted` with a `reference` matching
      `^BX-[0-9A-HJKMNP-TV-Z]{8}$`.
    - Calling it again for the same hold returns the same order and session.
    - A hold with a reserved seat gives 422 `invalid_order`
      (`reserved_not_for_sale`).
    - An unpriced section gives 422 `invalid_order` (`not_on_sale`).
    - An ended hold gives 409 `hold_ended`.
    - A wrong token gives 404.
14. **Webhook security:**
    - A bad signature, a missing header, or a timestamp outside tolerance
      each gives 400 and no state change.
    - The raw body is never logged; a captured logger shows only `evt_` and
      `cs_` IDs.
15. **Webhook effects:**
    - `completed` for a pending order with an active hold gives `paid`, the
      email stored, the places sold and one `order.paid` row.
    - Delivering the same event 3 times, or `completed` after `expired`, or
      `expired` after `completed`, gives exactly one sale and one
      `order.paid` (PCI-4).
16. **Late payment:**
    - `completed` after the hold expired, with places still free, gives
      `paid`.
    - With the places since sold out, it gives `refund_pending` and one
      `order.refund_required`.
17. The order view, with the right hold token, returns status, reference,
    lines and total, but no email. A wrong token gives 404.
18. With a captured logger over the API suite, no log line contains:
    - an email address;
    - the `Stripe-Signature` value;
    - a hold token or `Idempotency-Key`;
    - a `client_secret`;
    - a key matching `sk_`, `whsec_` or `pk_` (GDPR-7, PCI-5, PCI-6).
19. The API env schema rejects a `STRIPE_TEST_SECRET` that doesn't start
    with `sk_test_` and a publishable key that doesn't start with
    `pk_test_`, naming the variable without echoing its value (PCI-6).

**Worker (integration, Postgres + Temporal + Mailpit + fake gateway)**

20. A paid order sends exactly one confirmation to Mailpit within 10 s.
    The confirmation:
    - goes to the buyer email;
    - contains the reference, venue, total and breakdown, and the terms;
    - contains no access category;
    - has an HTML part with `lang="en-GB"` and a text part.

    Redelivering `order.paid` sends no second email.

21. With SMTP down, the order stays `paid`. The email is sent once SMTP
    returns.
22. **Abandonment:** a hold with a pending order that expires (with
    `HOLD_LENGTH_SECONDS=2`) leads to the gateway's `expireSession` being
    called once, the order becoming `expired`, and the places becoming
    available.
23. `order.refund_required` leads to one gateway refund with key
    `refund-<orderId>` for the full total, the order becoming `refunded`,
    and one refund email. A gateway failure is retried, and a repeated
    delivery doesn't refund twice.

**Stripe contract (integration, real test mode)**

These run only when `STRIPE_TEST_SECRET` is set; otherwise they're
skipped and say so.

24. With the real Stripe gateway:
    - creating a session gives a `cs_test_` embedded session with the
      right amounts and expiry;
    - `expireSession` expires it, and expiring it again succeeds;
    - a refund on a `pm_card_visa` test PaymentIntent succeeds with the
      idempotency key (PCI-7).

    No card number appears in the test code.

**Web (unit + browser, Chromium, fake gateway rendering a test checkout
stub)**

25. Every page in the flow (venue, performance, checkout, complete, plus
    the sold-out and expired states) has no serious or critical axe
    violations. Each has `lang="en-GB"`, a title and one `<h1>`, and works
    at 320 px width without horizontal scroll (A11Y-1, A11Y-7, A11Y-11).
26. **Keyboard only:** venue → performance → choose quantity → checkout →
    the stub's pay button → confirmation shows the reference. Focus is
    visible at every step and never hidden (A11Y-2).
27. **Countdown, with a 30 s hold:**
    - the alert appears at least 20 s before expiry;
    - one activation of **Extend time** moves the expiry, which the API
      confirms;
    - live-region text changes only at the milestones (a mutation count
      test);
    - at expiry, the expired state is shown and announced (A11Y-5, A11Y-6).
28. Prices: every price on every page equals the API `totalPence`
    formatted, and has the breakdown next to it. No step shows a higher
    total than the performance page (UKR-6).
29. The checkout page shows the terms block above the payment area
    (UKR-7). The companion control only sends an access need when the
    consent box is ticked; unticked, the form shows a tied field error.
30. The hold token, `Idempotency-Key` and `client_secret` never appear in
    any URL during the flow. The cookie is `httpOnly`.

**Admin (browser)**

31. A performance with GA partly sold and partly held shows "N sold, M held
    of C" in the visible text, the accessible name and the table. Axe stays
    clean.

**Repo**

32. `.env.example` documents every new key (owner edit, concern 13). The
    env-example test passes. CI stays green on all required checks. `pnpm
test:int` takes no more than 3 minutes longer than on `main`.

## Data model impact

These tables are new. Each carries `venue_id`, with composite FKs to
same-venue parents.

| Table               | Key columns                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ga_price`          | PK `(performance_id, section_id)`, `venue_id`, `face_pence` int ≥ 0, `fee_pence` int ≥ 0, `updated_at`; FK to a GA section                                                                                                               |
| `order`             | `id`, `venue_id`, `performance_id`, `hold_id` (unique), `reference` (unique per venue), `status` enum, `total_pence`, `currency` (`GBP`), `terms_version`, `terms_shown_at`, `created_at`, `paid_at`, `ended_at`, `confirmation_sent_at` |
| `order_line`        | `order_id`, `section_id`, `kind` (`standard` \| `companion`), `quantity`, `unit_face_pence`, `unit_fee_pence`, `line_total_pence`                                                                                                        |
| `order_buyer`       | PK `order_id`, `email` (nullable after pseudonymisation), `pseudonymised_at`                                                                                                                                                             |
| `order_access_need` | `order_id`, `need` (enum `access_feature`), `consent_version`, `consented_at`                                                                                                                                                            |
| `payment`           | `order_id` (unique), `stripe_checkout_session_id` (unique), `stripe_payment_intent_id`, `amount_pence`, `status`, `refund_id`, timestamps. No card brand or last 4 (not needed, GDPR-2/PCI-2)                                            |
| `stripe_event`      | PK `id` (`evt_…`), `type`, `received_at`                                                                                                                                                                                                 |

Changes to existing tables:

- `ga_inventory`: gains `sold` int default 0, with `CHECK (sold >= 0 AND
held + sold <= capacity)`. This replaces the `held BETWEEN 0 AND capacity`
  check with `held >= 0` plus the combined check.
- `hold`: `status` enum gains `purchased`. Gains `idempotency_key_hash`
  (bytea, nullable), with a unique index on `(venue_id,
idempotency_key_hash)` and a `request_hash`.
- `hold_ga`: gains `companion` boolean default false.
- `hold_access_need`: `seat_id` becomes nullable, and `section_id` is added,
  with `CHECK` that exactly one of the two is set.

All amounts are integer pence. Personal data lives only in
`order_buyer.email` and `order_access_need` (concern 12).

## Interfaces

**HTTP API (JSON, Zod contracts)**

| Method + path                                               | Auth                     | Success                     |
| ----------------------------------------------------------- | ------------------------ | --------------------------- |
| `GET /venues/:venueId/performances/:performanceId/ga-offer` | none                     | 200 `GaOffer`               |
| `POST /venues/:venueId/performances/:performanceId/holds`   | none, `Idempotency-Key?` | 201 `HoldCreated` (changed) |
| `POST /venues/:venueId/holds/:holdId/checkout`              | `Hold-Token`             | 201/200 `CheckoutStarted`   |
| `GET /venues/:venueId/holds/:holdId/order`                  | `Hold-Token`             | 200 `OrderView`             |
| `POST /webhooks/stripe`                                     | `Stripe-Signature`       | 200 `{ received: true }`    |
| `GET .../performances/:performanceId/availability`          | none                     | 200, GA entries gain `sold` |

- **`GaOffer`:** `{ performanceId, startsAt, venueName, eventName,
sections: [{ sectionId, name, onSale, facePence, feePence, totalPence,
remaining }], accessNeedCategories, consentVersion }`.
- **`CreateHoldRequest`:** GA lines gain `companion?: { accessNeed }`. The
  request gains `accessNeedConsent?`.
- **`CheckoutStarted`:** `{ orderId, reference, status, totalPence, lines,
terms: { version, text }, payment: { provider: "stripe" | "fake",
clientSecret } }`. `provider: "fake"` comes only from the test-injected
  gateway; there is no env switch for it.
- **`OrderView`:** `{ reference, status, performance, lines, totalPence }`.
  No email.
- **Errors:** `ErrorBody.error` gains `invalid_order` (422 with `rule`) and
  `idempotency_mismatch` (422). A Stripe failure maps to the existing 503
  `unavailable`.

**Payment port (`apps/api`, `apps/worker`)**

`PaymentGateway { createCheckoutSession, expireSession, refund }`. All
calls carry idempotency keys. Implementations: `StripeGateway` and
`FakeGateway`, which is test-only and lives under `test/support`.

**Temporal (task queue `boxoffice`)**

| Workflow                    | Workflow ID                    | Activities                                  |
| --------------------------- | ------------------------------ | ------------------------------------------- |
| `orderConfirmationWorkflow` | `order-confirmation-<orderId>` | `sendOrderConfirmation`                     |
| `checkoutCleanupWorkflow`   | `checkout-cleanup-<orderId>`   | `expireCheckoutSession`, `markOrderExpired` |
| `lateRefundWorkflow`        | `late-refund-<orderId>`        | `refundOrder`, `sendRefundNotice`           |

**Outbox event types (new)**

- `hold.purchased`, `order.created`, `order.paid`, `order.expired`,
  `order.refund_required`, `order.refunded`.
- Payload: `{ orderId?, holdId?, venueId, performanceId }` plus times.

**Env**

| App    | Keys                                                                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api    | `STRIPE_TEST_SECRET` (must start with `sk_test_`), `STRIPE_WEBHOOK_SECRET` (`whsec_`), `HOLD_TOKEN_SECRET` (≥ 32 bytes), `WEB_BASE_URL` (for `return_url`) |
| worker | `STRIPE_TEST_SECRET`, `SMTP_URL`, `MAIL_FROM`                                                                                                              |
| web    | `API_URL`, `STRIPE_TEST_PUBLISHABLE_KEY` (must start with `pk_test_`)                                                                                      |

All are Zod-validated, and their values are never logged.

**Local:** Mailpit (SMTP :1025, UI :8025) runs next to Postgres. Webhooks
reach the local API via `stripe listen --forward-to
localhost:4000/webhooks/stripe`. The README documents both.

**Commands:** `pnpm db:new ga-sales` (once).

## Failure modes

| Failure                                               | Behaviour                                                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two buyers race for the last places                   | The `held + sold + n <= capacity` conditional update picks winners. The loser gets 409, and the web says how many remain (AC 6).                                |
| Client retries hold create after a timeout            | The same `Idempotency-Key` returns the same hold and token (AC 12).                                                                                             |
| Stripe is down at checkout start                      | 503. The order stays `pending_payment` with no session. Retrying uses the same idempotency key, so one session is created.                                      |
| Webhook duplicated or reordered                       | `stripe_event` uniqueness plus conditional state transitions make it a no-op (AC 15).                                                                           |
| Webhook never arrives                                 | Stripe retries for 3 days. Meanwhile the confirmation page keeps "confirming…" and then says the email will follow. No sale happens without a verified webhook. |
| Hold expires while the buyer is on the payment iframe | Cleanup expires the session and the iframe shows Stripe's expired state. Our page shows the expired message (AC 22).                                            |
| Payment completes in the instant after the hold ended | Re-sold if places are free; otherwise refunded in full automatically, with an email (AC 16, 23).                                                                |
| Refund call fails                                     | `lateRefundWorkflow` retries with backoff. The order stays `refund_pending`, visible in logs by `orderId`.                                                      |
| SMTP down                                             | The order stands. The activity retries for up to 3 days, then logs `confirmation_failed` (AC 21).                                                               |
| Crash after SMTP send, before marking sent            | A duplicate email is possible (at least once, concern 9).                                                                                                       |
| Buyer goes back and re-submits checkout               | Checkout is idempotent per hold: the same order and session.                                                                                                    |
| Buyer pays in two tabs for one hold                   | One session per order, so only one payment is possible.                                                                                                         |
| Webhook secret wrong or rotated                       | Every webhook gets 400. Stripe retries; fixing the secret recovers within Stripe's retry window.                                                                |
| Performance starts with a pending order               | Checkout start refuses a started performance. A pending session's payment that completes after the start is still honoured if places exist (concern 14).        |

## End-to-end verification step

1. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`,
   `pnpm test` and `pnpm db:check`.
2. Run `pnpm test:int`. With `STRIPE_TEST_SECRET` set locally, the Stripe
   contract tests run too.
3. Locally:
   - Start Postgres, Mailpit and `pnpm temporal:dev`, then run `pnpm
db:seed`.
   - Run `stripe listen --forward-to localhost:4000/webhooks/stripe` and
     put its `whsec_` into `STRIPE_WEBHOOK_SECRET`.
   - Start `api` with `HOLD_LENGTH_SECONDS=120`, then `worker`, `web` and
     `admin`.
   - In the browser, keyboard only, buy 2 standing places at the studio.
     The owner types Stripe's test card into Stripe's iframe by hand; it
     never enters the codebase.
   - Check that:
     - the confirmation page shows the reference;
     - Mailpit has one email with the total, breakdown and terms;
     - admin shows "2 sold, 0 held of 200";
     - the Stripe dashboard (test) shows one payment.
   - Start a second purchase and let the hold expire on the checkout page.
     Check the expired message, an expired session in the dashboard,
     "0 held" in admin, and no email.
   - Run `stripe events resend <evt>` for the first payment and check that
     nothing changes.
4. Open the PR. All required CI checks pass.

## Flagged concerns

1. **A11Y-5 vs hosted Checkout redirect (G-2).** The owner chose Stripe
   Checkout (hosted). In redirect mode the buyer leaves our page for at
   least 30 minutes (Stripe's minimum session life), with a time limit they
   can't see or extend. That fails A11Y-5 and WCAG 2.2.1, and the session
   outlives the 10-minute hold. → The spec uses **embedded** Checkout. It's
   the same Stripe-hosted product and still SAQ A, so card entry remains
   Stripe-only (PCI-1). Our countdown and extend stay on screen, and the
   hold governs the session. If the owner wants redirect mode, the A11Y-5
   gap needs an owner decision record.
2. **Concern 8 of holds vs deploying (G-1).** No hosting exists: no Fly
   apps and no `fly.toml`, and `deploy.yml` only pushes images. Deploying
   preview and staging means:
   - Fly apps for web, API and worker;
   - Postgres;
   - a Temporal Cloud namespace;
   - Mailpit;
   - secrets;
   - a public webhook endpoint;
   - an access gate, because an unauthenticated hold API lets anyone hold
     all inventory.

   That's an intent's worth of infrastructure by itself. → Recommendation:
   this intent ships local and CI only, using `stripe listen` for webhooks.
   A separate "hosted preview and staging" intent follows at once, with a
   shared basic-auth gate on web and API, and only `/webhooks/stripe` open
   (signature-verified). The owner asked for deployment in this intent, so
   this needs their decision. If they keep it, add ACs for the Fly apps,
   the gate (401 without credentials, webhook exempt), and an E2E run on
   staging.

3. **No price endpoint.** The intent says prices come from "seed or the
   API". An unauthenticated price write would let anyone change prices. →
   Seed and a db function only. Price editing comes with staff auth (G-6).
4. **A11Y-8, A11Y-9: access in GA (G-3).** GA sections store only a
   capacity, so there are no access places, and a disabled GA buyer can't
   get the free companion place (`decisions/0002`) through the same flow
   (A11Y-8). → Recommended: a companion-only GA option. A declared
   category plus explicit consent gives one extra free place in the same
   section and order. Wheelchair or viewing-platform capacity in GA stays a
   later intent. The alternative (defer all GA access) leaves disabled
   buyers with no route through this flow, which A11Y-8 and A11Y-9 don't
   allow without an owner decision record.
5. **A11Y-9 wording for GA.** `decisions/0002` says the companion seat is
   "next to the access seat". GA has no seats. → A companion place in the
   same GA section is treated as meeting it. Owner to confirm.
6. **GDPR-4: access need moves to the order** (holds concern 6). → It's
   copied at checkout to `order_access_need`, apart from the order, with
   the consent version and time. It's deleted 30 days after the
   performance or when the order expires. It's never in emails, outbox,
   logs, admin or API responses. No staff role can see it yet, because no
   staff seating or admitting UI exists. The scanner (intent 9) will read
   it.
7. **GDPR-4: the companion line itself hints at a disability.** The email
   says "1 companion place (free)", and `order_line.kind = companion` is
   visible to whoever reads the order. → Kept: A11Y-9 needs the companion
   ticket in the same order, and the email goes only to the buyer. No
   category is shown. Owner to confirm that this is acceptable.
8. **PCI-1, PCI-3, PCI-4, PCI-5, PCI-6, PCI-7.**
   - Card entry is only in Stripe's iframe.
   - The webhook is verified on the raw body before parsing.
   - `stripe_event` is written in the effect's transaction.
   - Logs carry `evt_`, `cs_` and `pi_` IDs only.
   - Keys must be `sk_test_` or `pk_test_` or the app won't start, and the
     browser sees only the publishable key.
   - Contract tests use `pm_card_visa`.

   → ACs 14–19 and 24. Card brand and last 4 are deliberately not stored,
   because nothing displays them.

9. **At-least-once emails.** A crash between the SMTP send and the update
   can resend a confirmation. → Accepted. Exactly-once would need provider
   idempotency, which Mailpit doesn't have. Revisit with a real provider.
10. **Holds concern 9: `Idempotency-Key` returning the token.** Only the
    token's hash is stored, so a replay can't return the original random
    token. → With a key, the token is derived as HMAC(`HOLD_TOKEN_SECRET`,
    venue and key). Anyone holding the key can get the token, so the key
    must be as secret as the token. The web generates it server-side per
    form render. Owner to accept the new secret and derivation (G-10).
11. **GDPR-3: financial year end.** The 6-year rule needs a financial year
    end, and venues don't have one modelled. → Assume 31 March for every
    venue until venue settings exist (intent 8). Owner to confirm.
12. **GDPR-5, GDPR-6: export and erasure tooling doesn't exist** (intent
    10). This intent adds `order_buyer.email` and `order_access_need`. →
    Until intent 10, a venue can't answer an access or erasure request from
    Boxoffice. That's acceptable only while every environment holds
    invented data (GDPR-8: `example.com` emails in fixtures; test-mode
    buyers). Intent 10 must cover both tables, outbox (IDs only), Mailpit
    or provider logs, and the Stripe payment's email. Owner to confirm it's
    a blocker for any real customer.
13. **`.env.example` is agent-protected.** The owner adds `STRIPE_TEST_SECRET`,
    `STRIPE_WEBHOOK_SECRET`, `STRIPE_TEST_PUBLISHABLE_KEY`,
    `HOLD_TOKEN_SECRET`, `WEB_BASE_URL`, `SMTP_URL` and `MAIL_FROM` (empty
    values) at the matching plan step, as with `HOLD_LENGTH_SECONDS`. The
    CI Stripe contract tests need `STRIPE_TEST_SECRET` as a GitHub secret.
    Fork PRs skip them, so they can't be a required check.
14. **Late payment after the performance starts.** A session opened before
    the start could complete just after it. → Honoured if places exist,
    since the buyer can still attend late. Owner may prefer an automatic
    refund instead.
15. **UKR-7, UKR-8: terms wording.** The spec fixes the product behaviour
    and a template. UKR says final wording is the venue's to approve. The
    exchange policy is "none" for every event until per-event settings
    exist (`decisions/0008`). → Owner approves the v1 wording at plan time.
16. **UKR-9, UKR-10: the late-payment refund** is the only refund in this
    intent. → It's a full refund (face and fees) to the original payment
    via a Stripe refund, idempotent. It isn't a customer-facing refund
    feature, and intent 7 builds those.
17. **CLAUDE.md path `packages/domain/money.ts`.** The package keeps
    sources in `src/`, so the file is `packages/domain/src/money.ts`.
    "No Number arithmetic on amounts" is enforced as "only inside
    `money.ts`" (AC 1). Owner to confirm, and CLAUDE.md's path can be fixed
    in the same PR.
18. **The fake payment gateway renders a test stub in web.** Browser tests
    can't drive Stripe's iframe without a network connection and typed card
    numbers (PCI-7). → The fake is injected only by the test harness, with
    no env switch. Keyboard behaviour inside Stripe's real iframe (A11Y-2,
    "no traps in and out") is checked by hand in the E2E step only.

## Decisions (owner, 2026-10-07)

The owner accepted every recommendation below (G-1 to G-11) and the handling
proposed in Flagged concerns 1–18: local and CI only, with hosted preview and
staging as the next intent; embedded Stripe Checkout; a companion-only GA
access option with explicit consent; Mailpit everywhere; an HMAC-derived token
for `Idempotency-Key` with `HOLD_TOKEN_SECRET`; prices from seed only; a
31 March financial year end; late payments after the start honoured if places
remain.

| #    | Question (intent open question)              | Recommendation                                                                                                                                                                                           |
| ---- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-1  | Deploying vs holds concern 8 (1)             | Local and CI only here. A "hosted preview and staging" intent follows straight after, with a basic-auth gate and only the webhook open (concern 2).                                                      |
| G-2  | Hold vs Checkout session (2)                 | Embedded Checkout. The hold governs. Session `expires_at = max(now+30 min, hold's latest end)`. Cleanup expires the session when the hold ends. A late payment is re-sold or fully refunded (concern 1). |
| G-3  | Access in GA (3)                             | A companion-only option with a declared category and explicit consent. GA access capacity comes later (concerns 4, 5).                                                                                   |
| G-4  | Email delivery (4)                           | SMTP to Mailpit in every environment. A real provider is a later intent.                                                                                                                                 |
| G-5  | Buyer email retention and use (5)            | Email only, collected by Stripe Checkout. Contract basis, for the venue as controller. Pseudonymised 2 years after the last event. No marketing consent (GDPR-9).                                        |
| G-6  | Quantity limits and pricing (6, 7)           | 1–10 places per order (plus an optional companion). The web sells one section per order. A per-place booking fee is stored apart and included in the headline total. Seed sets a non-zero fee.           |
| G-7  | Email failure (8)                            | The order stands. Temporal retries for up to 3 days. No resend UI.                                                                                                                                       |
| G-8  | Order reference and lookup (9)               | `BX-` plus 8 Crockford base32 characters. The confirmation page works only while the hold cookie exists. The email is the lasting record. No lookup page.                                                |
| G-9  | Terms at checkout (10)                       | A versioned template in the domain, shown above payment and repeated in the email. `terms_version` is stored on the order (concern 15).                                                                  |
| G-10 | Idempotent hold create (holds concern 9)     | HMAC-derived token when an `Idempotency-Key` is sent, using the new `HOLD_TOKEN_SECRET` (concern 10).                                                                                                    |
| G-11 | Financial year end; late payment after start | 31 March for all venues (concern 11). Honour a late payment after the start if places exist (concern 14).                                                                                                |
