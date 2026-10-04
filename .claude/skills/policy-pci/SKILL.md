---
name: policy-pci
description: Payment-card (PCI DSS) constraints for Boxoffice. Use when designing, speccing or reviewing anything that collects, stores, displays or transmits payment details — checkout and payment flows, Stripe integration, payment webhooks, refunds or exchanges that touch payment intents, receipts showing card info, or box-office staff taking payments — even if the request never says "PCI". Not for features with no payment data.
---

# Payment-card policy (PCI)

Boxoffice stays at PCI DSS **SAQ A**: card data never touches our servers,
pages, logs or staff. Every rule below protects that. A breach of any of them
widens audit scope for the whole platform, so treat them as hard constraints.

## Rules

- **PCI-1 Card entry is Stripe-hosted.** Only Stripe Payment Element or
  Checkout collect card details. No custom card inputs, and our API never
  receives or proxies card data.
- **PCI-2 No card data anywhere.** Never PAN, CVV/CVC, expiry or track data in
  code, logs, DB, URLs, analytics, error reports, tests or fixtures. We may
  store Stripe IDs (`pi_`, `pm_`, `cus_`, `ch_`, `re_`), card brand and last 4.
- **PCI-3 Webhooks are verified.** Check the `Stripe-Signature` header against
  the raw request body with the timestamp tolerance; reject anything else
  before parsing it.
- **PCI-4 Payment effects are idempotent.** Persist the webhook `event.id`
  (unique constraint) in the same transaction as its effect, so duplicate or
  out-of-order deliveries are no-ops. Calls to Stripe carry idempotency keys.
- **PCI-5 Log IDs, not objects.** Logs, traces and error reports carry Stripe
  object IDs only, never whole Stripe objects or payment request bodies (they
  contain billing names and addresses; see policy-gdpr).
- **PCI-6 Keys stay server-side and test-mode.** Secret and webhook keys come
  from Fly / GitHub secrets; the browser only ever sees the publishable key.
  Only `sk_test_` / `pk_test_` keys exist; a live key anywhere is an incident.
- **PCI-7 Tests use Stripe tokens.** Use test payment methods such as
  `pm_card_visa` and `pm_card_chargeDeclined`, not raw card numbers (even
  Stripe's published test numbers), so PCI-2 and secret scanning stay quiet.
- **PCI-8 Staff never handle card numbers.** Phone bookings send the customer
  a Stripe payment link. No admin screen accepts card details, MOTO included.
- **PCI-9 No in-person card payments yet.** Card readers (Stripe Terminal) are
  out of scope until an intent adds them and updates this skill.

## Applying this in a spec or review

For each rule the design touches, add a line under **Flagged concerns**:
`PCI-n: <what in the intent/design conflicts or needs care> → <how the spec
handles it>`. If the intent asks for something a rule forbids (staff keying
cards, storing expiry for "card on file" display), flag it and leave the
decision to the owner; never quietly redesign around it. Flag a rule only
when the intent or your design actually does what it governs; don't list
rules to show they were considered. If no rule is touched, say nothing
about PCI.
