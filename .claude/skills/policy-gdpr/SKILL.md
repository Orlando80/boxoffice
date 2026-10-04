---
name: policy-gdpr
description: UK GDPR constraints for Boxoffice. Use when designing, speccing or reviewing a feature that collects, stores, displays, exports, deletes or transmits personal data about attendees, buyers, ticket holders or venue staff — names, emails, phone numbers, access requirements, waitlists, attendee lists, scanner data, data exports, erasure requests, or seed data, fixtures and test data containing people. Not for infrastructure, tooling, CI, pricing, or seat maps (including accessible-seat flags) that hold no personal data.
---

# Personal-data policy (UK GDPR)

Each **venue is the controller** of its customers' data; **Boxoffice is the
processor** and acts only on the venue's behalf. Every rule below keeps us
inside that role and makes a venue's data-subject requests answerable.

## Rules

- **GDPR-1 Venue purposes only.** Use attendee data only to sell, admit,
  refund and report for the venue it belongs to. Never across tenants, and
  never for Boxoffice's own purposes (cross-venue profiles, our analytics).
- **GDPR-2 Minimise.** Each personal field needs a stated purpose; flag
  fields the feature doesn't need rather than silently dropping them. Copies
  get the minimum too: the scanner's offline cache holds ticket and seat IDs,
  plus access-need categories (GDPR-4), never names or contact details.
- **GDPR-3 Every field has a retention period**, enforced by a scheduled job,
  never by hand. Copies (profiles, snapshots, caches, reports) inherit the
  period of the data they copy. Venues can configure these defaults:

  | Data | Kept for | Then |
  |---|---|---|
  | Order financial record (amounts, Stripe IDs, dates) | 6 years after financial year end | deleted |
  | Buyer name, email, phone | 2 years after their last event | pseudonymised |
  | Named ticket-holder names | 90 days after the event | deleted |
  | Waitlist entries (all fields) | 30 days after the event | deleted |
  | Access requirements | 30 days after the event | deleted |
  | Door-scan records | 90 days after the event | anonymised |

- **GDPR-4 Access requirements are health data.** Collect them only with
  explicit consent, store them apart from the order, and show them only to
  staff roles that seat or admit the customer, as categories (wheelchair,
  carer seat), not free text. Keep them out of emails and operational lists;
  the person's own export (GDPR-6) still includes them.
- **GDPR-5 Erasure deletes, or pseudonymises what finance must keep.**
  Personal fields on a financial record are replaced while the record
  survives its 6 years; everything else is deleted. Erasure reaches every
  copy: outbox events, search indexes, scanner caches and the Stripe customer.
- **GDPR-6 Export is complete.** A venue can export everything held about one
  person as JSON. A spec that adds a personal field adds it to the export.
- **GDPR-7 No personal data in logs**, traces, error reports, analytics or
  URLs. Log internal IDs.
- **GDPR-8 Fixtures are invented.** Use `example.com` emails, UK drama-range
  phones (07700 900000–900999) and made-up names and venues.
- **GDPR-9 No marketing use.** Only transactional messages go to attendees.
  Marketing consent and campaigns are out of scope; flag any feature that
  needs them.

## Applying this in a spec or review

For each rule the design touches, add a line under **Flagged concerns**:
`GDPR-n: <what in the intent/design conflicts or needs care> → <how the spec
handles it>`. If the intent asks for something a rule forbids, flag it and
leave the decision to the owner; never quietly redesign around it. Flag a
rule only when the intent or your design actually does what it governs;
don't list rules to show they were considered. When a conflict blocks the
design, flag the blocking rules and stop there rather than applying the
rest to a design that may not happen. If the feature holds no personal
data, say nothing about GDPR.
