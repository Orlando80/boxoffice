# Intent: GA sales with Stripe test mode and confirmation email

Status: draft
Originator: repo owner
Date: 2026-10-07

## Problem

Intent 3 (holds) can set GA places aside on a timer, but nothing can be
bought. So:

- A hold can only expire or be released. Nothing turns a hold into an
  order, and a GA place is never "sold".
- Boxoffice has no customer UI. `apps/web` has no purchase page, so no
  customer-facing accessibility rules have been tested against real pages
  yet.
- There is no payment flow. Stripe, idempotent webhooks and the PCI
  boundary are only written down in the brief and `/policy-pci`.
- Boxoffice stores no buyer personal data. The first email address it
  stores is where `/policy-gdpr` first applies for real.
- The `hold.*` outbox events have no consumer apart from the hold workflow,
  and nothing sends email.
- Admin can show held GA places but not sold ones, so staff can't tell how
  a performance is selling.

This is the brief's intent 4: the first payment flow.

## Proposed outcome

A buyer can buy GA places for a performance from a minimal `apps/web`
page. They pay in Stripe test mode and get an email confirming the order.

**Purchase flow (`apps/web`)**

- Minimal pages: choose a performance and a GA section, choose a quantity,
  see the all-in price, pay, and see a confirmation page.
- Choosing a quantity creates a hold through the intent 3 API. The page
  shows how long the hold has left.
- Guest checkout only. The buyer gives an email address for the
  confirmation. There are no accounts and no named attendees.

**Pricing**

- Each GA section of a performance has one price, in integer pence, with
  any booking fee included in the headline figure (`decisions/0009`). Seed
  data or the API sets it. Nothing in admin edits prices.

**Payment**

- Card details are collected only on Stripe Checkout's hosted page, so no
  card data reaches Boxoffice (`/policy-pci`).
- When payment succeeds (confirmed by a Stripe webhook), the hold becomes
  an order and its GA places count as **sold**, not held.
- Webhooks are idempotent. A webhook delivered twice, or in a different
  order, never creates a second order or sells a place twice.
- Payments that are abandoned or come in late are handled: an unpaid or
  expired Checkout session leaves no order behind, and a payment that
  arrives after its hold has ended still gets a defined result.

**Confirmation**

- After the order is confirmed, the buyer is emailed the order details:
  performance, section, quantity, total and order reference. No scannable
  ticket yet.
- The email is sent from an outbox event (e.g. `order.confirmed`), not
  inside the payment request.

**Admin**

- The admin seat map and table show sold GA counts next to held counts,
  for example "N sold, M held of C". Admin stays read-only.

**Environments**

- The flow runs on Fly preview and staging with Stripe test mode, not only
  locally and in CI.

## Affected users and systems

- **Buyers:** for the first time, members of the public use Boxoffice to
  pick, pay for and receive confirmation of GA places.
- **Venue box-office staff:** see sold and held GA counts in admin. They
  can't sell, refund or edit orders.
- **Later intents:** reserved-seat sales (5) reuse the order and payment
  path. Price tiers (6) replace one price per section. Refunds (7) start
  from these orders and payment intents. Finance (8) reads orders. The
  scanner (9) needs a ticket artefact that this intent doesn't issue.
  GDPR tooling (10) has to export and erase the buyer emails stored here.
- **Code:** `apps/web` (first customer pages), `apps/api` (order, checkout
  and webhook endpoints), `apps/worker` (outbox consumers: confirmation
  email, payment cleanup), `apps/admin` (sold counts),
  `packages/domain/reservation` (hold → sold transition),
  `packages/domain/money.ts` (prices and totals), `packages/db` (prices,
  orders, payments; generated migrations), `packages/contracts`.
- **External:** Stripe (test mode, Checkout, webhooks) and an email
  delivery mechanism (see open questions).
- **Infrastructure:** Stripe keys and webhook signing secrets in Fly
  secrets and GitHub secrets for preview and staging.

## Constraints

- **GA only.** Reserved seats can be held (intent 3) but aren't sold here.
  Reserved-seat sales come with the reservation engine (intent 5).
- **Money is integer pence** through `packages/domain/money.ts`. No floats.
- **No card data in the codebase.** Use Stripe Checkout (hosted) and
  Stripe IDs only (`/policy-pci`).
- **Reservation changes go through `packages/domain/reservation`**, and that
  includes marking places sold.
- **Fees in the headline price** (`decisions/0009`, UKR-6). No charge added
  at checkout.
- **Personal data is limited to the buyer's email address.** The
  `/policy-gdpr` lawful basis, retention and minimisation rules apply.
- **Public repo:** no real names, emails or venues in fixtures or seeds.
  Stripe and email secrets only in Fly or GH secrets.
- **Customer UI meets WCAG 2.2 AA** (`/policy-accessibility`). That includes
  the hold countdown (A11Y-5), which intent 3 left to this intent.
- **Migrations only via `pnpm db:new`.**
- **Stripe test mode only.** No live keys in any environment.
- **Carry-overs from the holds spec (intent 3):** add `Idempotency-Key` to
  hold creation before buyers use it (concern 9). Build the A11Y-5 countdown,
  the 20-second warning and one-action extend in the web UI (concern 2). If
  access needs are in scope (open question 3), collect explicit consent
  before a category reaches the hold API (concern 6).

## Out of scope

- Selling reserved seats; contention hardening, soak gate (intent 5).
- Price tiers, discounts, promo codes, waitlists (intent 6).
- Refunds, exchanges and cancellations (intent 7). Late-payment handling
  may need an automatic refund, though; see open question 2.
- Scannable tickets, QR codes, wallet passes (intent 9).
- Buyer accounts, sign-in, order history pages, named attendees.
- An admin price editor, admin sales actions, staff auth.
- Finance exports and reconciliation (intent 8).
- Production deployment and live payments.
- On-sale queues, rate limiting and bot protection.

## Open questions

1. **Deploying conflicts with holds concern 8.** The holds spec says the
   API and worker must not run anywhere public until auth or rate limiting
   lands, because an unauthenticated hold API lets anyone hold all the
   inventory. This intent wants the flow on preview and staging but leaves
   rate limiting out of scope. Which gives way: keep preview/staging
   private (e.g. Fly private networking or basic auth in front of web and
   API), bring minimal rate limiting into this intent, or run locally and
   in CI only for now?
2. **Hold length vs Stripe Checkout session.** A Checkout session can't
   expire sooner than 30 minutes, but a hold lasts 10 minutes, extendable
   10 times. Options: extend the hold when redirecting to Stripe so it
   covers the session; expire the session ourselves when the hold ends and
   refund any payment that arrives late; or something else. Which one?
   And what does the buyer see if the hold ends while they're on Stripe's
   page?
3. **Access in GA.** A GA section stores only a single capacity. Does this
   intent model wheelchair spaces or access places in GA sections? Does a
   GA buyer who declares an access need get a free companion place in the
   same order (`decisions/0002`, A11Y-9)? Or is access GA deferred? (This
   needs `/policy-accessibility` input at spec time.)
4. **Email delivery.** No real email provider was chosen for this intent,
   but the flow has to run on preview and staging. On those environments,
   are emails captured (mail catcher, provider sandbox) or really sent?
   Which provider, if any?
5. **Buyer email retention and use.** How long are order emails kept, and
   on what lawful basis (contract)? Is any marketing consent collected?
   (The answer is probably no, since marketing automation is out of scope,
   but that needs confirming.)
6. **Order quantity limits.** What's the most GA places in one order? Is it
   the same as the hold limit from intent 3? Can one order cover more
   than one GA section?
7. **Booking fee.** Is there a booking fee at all in this intent? If so,
   is it per order or per ticket, and is it shown as a breakdown inside
   the all-in price?
8. **Confirmation email failure.** If the email can't be sent, does the
   order still stand (retry from the outbox), and can the buyer re-request
   it?
9. **Order reference and lookup.** What does the order reference look like?
   Can a guest buyer see their order again without an account (for
   example, a signed link in the email)?
10. **Terms and conditions at checkout.** What terms does the buyer agree
    to before paying, and where is that agreement recorded
    (`/policy-uk-refunds` checkout terms)?
