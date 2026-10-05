# Refunds go to the original payment method

- **Status:** accepted (owner delegated to Claude's recommendation)
- **Date:** 2026-10-05
- **Owner:** repo owner (@Orlando80)
- **Applies to:** `.claude/skills/policy-uk-refunds` rule UKR-10

## Question
How is money returned?

## Options
1. Stripe refund to the original payment method; credit/vouchers only as an optional alternative **(chosen)**
2. Account credit by default
3. Venue chooses per refund

## Why
Customers get their money back without friction, and it keeps payments inside Stripe (PCI).

## Consequences
Refunds are Stripe refunds on the original payment intent; no manual bank transfers or card details.
