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

## Local setup

Prerequisites:

- Node, at the version pinned in `.nvmrc` (`nvm use` or `fnm use`)
- pnpm, via corepack (`corepack enable`)
- Docker, for `pnpm test:int` and local image builds

```
pnpm install
pnpm temporal:dev   # Temporal dev server on localhost:7233, UI on :8233
```

Copy `.env.example` to `.env` if you need to override defaults.

| Command | What it does |
|---|---|
| `pnpm typecheck` | Type-check all packages |
| `pnpm lint` | Lint all packages |
| `pnpm test <path>` | Unit tests; pass a path while iterating |
| `pnpm test:int` | Integration tests (needs Docker) |
| `pnpm db:check` | Check migrations are consistent with the schema |
| `pnpm db:new <name>` | Generate a new migration (never hand-edit migrations) |
| `pnpm temporal:dev` | Run a local Temporal dev server |
| `pnpm soak` | Run the soak check |
| `pnpm ci:changed` | Run the CI checks for packages changed against `origin/main` |
| `pnpm docker:build <app>` | Build an app image locally |

`pnpm docker:build <app>` wraps `docker build` and passes `NODE_VERSION` read
from `.nvmrc`. `<app>` is one of api, web, admin, scanner, worker.

## Status

Bootstrapping. See [docs/bootstrap.md](docs/bootstrap.md) for the full brief.

### Intents

- [monorepo-skeleton](intent/monorepo-skeleton/intent.md): workspace, apps, CI and Docker images.

## Licence

[Apache-2.0](LICENSE). All venues, events and people in fixtures are invented.
