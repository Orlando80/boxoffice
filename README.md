# Boxoffice

Box-office and ticket inventory for mid-size venues (500–5,000 capacity):
reserved and general-admission seating, timed on-sales, holds and allocations,
price tiers, waitlists, refunds and exchanges, door scanning and finance
reconciliation.

It's also an experiment in an **AI-native software development lifecycle**,
where every change runs through a chain of version-controlled artefacts,
driven by Claude Code skills, subagents, hooks and CI.

## The loop

```
intent  →  spec  →  plan  →  implement  →  ship  →  maintain
  │          │        │          │           │          │
/intent   /spec    /plan    /implement    /ship    alerts → new intent
```

| Stage | Who | Output | Gate |
|---|---|---|---|
| Intent | any originator (box office, finance, marketing, front of house) | `intent/<slug>/intent.md` | owner merges |
| Spec | CI runs `/spec` when an intent merges; policy skills apply | `spec.md` with flagged concerns | owner (+ tech lead for reservations, payments, migrations) |
| Plan | engineer, in plan mode | `plan.md`: ordered steps, each with its proving test | human approval before code |
| Implement | `dev` → `qa` → `reviewer` subagents | code + tests | hooks block protected paths; the Stop hook refuses a red gate |
| Ship | `/ship` | PR linking intent, spec and plan | CI green + one human review |
| Maintain | alerts | incident record → new intent | loop closes |

The commit history of each `intent/<slug>/` folder is the audit trail.
Trivial changes (a one-sentence diff) skip the ceremony.

## Status

Bootstrapping. See [docs/bootstrap.md](docs/bootstrap.md) for the full brief.

### Intents

_None yet. The first one is the monorepo skeleton._

## Licence

[Apache-2.0](LICENSE). All venues, events and people in fixtures are invented.
