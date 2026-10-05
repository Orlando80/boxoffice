---
name: policy-uk-refunds
description: UK consumer-law constraints on refunds, exchanges, cancellations, prices and ticket terms for Boxoffice. Use when designing, speccing or reviewing anything about refunds or partial refunds, exchanges, cancelled, postponed or rescheduled events, changes of venue, date or headliner, booking or service fees, how prices and totals are displayed, checkout terms and conditions, order confirmations, credit or vouchers, or ticket resale and transfer — even if the request never says "consumer law". Not for internal finance exports, payment plumbing with no customer-facing effect, or seat maps and UI work that don't change prices, fees or terms.
---

# UK refunds and ticket terms policy

Boxoffice sells tickets to UK consumers on behalf of venues. The Consumer
Rights Act 2015, the Consumer Contracts Regulations 2013 and the DMCC Act
2024 (with CMA guidance on live events) set a floor that no venue setting or
term can go below. The rules below keep every venue above it. They set
product behaviour, not legal wording: final terms text is the venue's to
approve.

## Rules

- **UKR-1 Statutory rights can't be excluded.** No term, setting or message
  says or implies "no refunds under any circumstances" or lets a venue opt
  out of UKR-3/UKR-4. "Force majeure" never removes the refund for an event
  that doesn't happen.
- **UKR-2 No cooling-off for dated events, and say so.** Tickets for a
  specific date have no 14-day cancellation right (CCR reg 28(1)(h)); state
  that before payment. Undated products (gift vouchers, memberships) do have
  it; flag any feature that sells them.
- **UKR-3 Cancelled means everything back.** Face value, booking and delivery
  fees are refunded automatically to every affected order within 14 days,
  with no claim form. Credit or vouchers may be offered only alongside cash.
  (`decisions/0006`)
- **UKR-4 Rescheduled or materially changed means a choice.** A new date,
  venue or headline act, or a seat downgrade, gives each order the choice of
  keeping the tickets or a full refund including fees, with at least 14 days
  to decide; no reply means keep. Never move tickets with no refund option.
  (`decisions/0007`)
- **UKR-5 Lesser service, partial refund.** A worse seat or reduced event
  that the customer accepts refunds the price difference, fees pro rata.
- **UKR-6 Headline price is the total.** Every price shown, from listings to
  seat maps, includes mandatory booking and service fees; only genuinely
  optional extras are added later, labelled. No fee first appears at
  checkout (DMCC Act 2024). (`decisions/0009`)
- **UKR-7 Terms before payment, confirmation after.** Before paying, the
  customer sees the total, the venue as seller, and the refund and exchange
  terms for that event, not just a footer link. The confirmation email
  repeats them.
- **UKR-8 Exchanges and goodwill refunds are venue policy.** Configured per
  event, including any fee, shown before purchase, default none, and never
  below UKR-3/UKR-4. (`decisions/0008`)
- **UKR-9 Refund maths in pence.** Amounts are integers via
  `packages/domain/money.ts`; partial refunds allocate across face value and
  each fee, and per-line refunds sum exactly to the total. Refund effects are
  idempotent (PCI-4).
- **UKR-10 Back to the original payment method.** Refunds are Stripe refunds
  on the original payment; no bank transfers, no forced account credit.
  (`decisions/0010`)
- **UKR-11 Resale and transfer need their own decision.** Any feature that
  lets customers resell or pass on tickets carries extra legal duties
  (CRA 2015 s90); flag it for the owner.

## Applying this in a spec or review

For each rule the design touches, add a line under **Flagged concerns**:
`UKR-n: <what in the intent/design conflicts or needs care> → <how the spec
handles it>`. If the intent asks for something a rule forbids (credit-only
refunds, keeping fees on a cancelled show, a fee added at checkout), flag it
and leave the decision to the owner; never quietly redesign around it. Flag
a rule only when the intent or your design actually does what it governs;
don't list rules to show they were considered. If the feature doesn't touch
refunds, prices, fees or customer terms, say nothing about UK refunds.
