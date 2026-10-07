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

<!-- prettier-ignore -->
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

<!-- prettier-ignore -->
| Command | What it does |
|---|---|
| `pnpm typecheck` | Type-check all packages |
| `pnpm lint` | Lint all packages |
| `pnpm test <path>` | Unit tests; pass a path while iterating |
| `pnpm test:int` | Integration tests (needs Docker); also runs browser tests and installs Chromium on first run |
| `pnpm db:check` | Check migrations are consistent with the schema |
| `pnpm db:seed` | Migrate and load the invented seed venues into DATABASE_URL |
| `pnpm db:new <name>` | Generate a new migration (never hand-edit migrations) |
| `pnpm temporal:dev` | Run a local Temporal dev server |
| `pnpm soak` | Run the soak check |
| `pnpm ci:changed` | Run the CI checks for packages changed against `origin/main` |
| `pnpm docker:build <app>` | Build an app image locally |

`pnpm docker:build <app>` wraps `docker build` and passes `NODE_VERSION` read
from `.nvmrc`. `<app>` is one of api, web, admin, scanner, worker.

### Run the admin locally

> The admin app has no sign-in yet. Its venue picker lists every venue and is for local development only; do not deploy admin until the auth intent lands.

```
docker run -d --name boxoffice-pg -e POSTGRES_PASSWORD=change-me -p 5433:5432 postgres:17
export DATABASE_URL=postgres://postgres:change-me@localhost:5433/postgres
pnpm db:seed
pnpm --filter @boxoffice/api dev       # needs DATABASE_URL
pnpm --filter @boxoffice/admin dev     # API_URL defaults to http://localhost:4000
```

Then open http://localhost:3001.

### Run the worker and holds locally

> The hold API has no sign-in or rate limit yet. Do not deploy the API or the worker publicly until an auth and rate-limit intent lands.

Holds expire on a Temporal timer, so run the Temporal dev server and the worker
alongside the API. Use the database from the previous section.

```
pnpm temporal:dev                              # localhost:7233, UI http://localhost:8233
export DATABASE_URL=postgres://postgres:change-me@localhost:5433/postgres
pnpm --filter @boxoffice/worker dev            # needs DATABASE_URL; Temporal defaults to localhost:7233
HOLD_LENGTH_SECONDS=60 pnpm --filter @boxoffice/api dev   # optional: 60 s holds for quick expiry
```

In PowerShell, set variables with `$env:DATABASE_URL = "postgres://..."` and
`$env:HOLD_LENGTH_SECONDS = "60"` instead of `export`. The default hold length
is 600 seconds.

Find the IDs you need, then try the hold API. The hold token is returned once,
on create, and goes in the `Hold-Token` header, never in the URL.

```
API=http://localhost:4000
curl $API/venues                                  # venue ids
curl $API/venues/<venueId>/events/<eventId>       # performance ids
curl $API/venues/<venueId>/layouts/<layoutId>     # seat ids

# Create a hold. Access seats need role "access" and an accessNeed; the linked
# companion seat uses role "companion" in the same hold.
curl -X POST $API/venues/<venueId>/performances/<performanceId>/holds \
  -H "Content-Type: application/json" \
  -d '{"seats":[{"seatId":"<seatId>","role":"standard"}],"ga":[]}'

# Use the token from the create response.
curl $API/venues/<venueId>/holds/<holdId> -H "Hold-Token: <token>"
curl -X POST $API/venues/<venueId>/holds/<holdId>/extend -H "Hold-Token: <token>"
curl -X DELETE $API/venues/<venueId>/holds/<holdId> -H "Hold-Token: <token>"

# Held seats and GA counts for a performance (no token needed).
curl $API/venues/<venueId>/performances/<performanceId>/availability
```

A 409 means a conflict: `seats_unavailable` (lists the taken seat or section
ids), `extension_limit` (10 extensions used) or `hold_ended` (released or
expired). A 422 `invalid_hold` means the request breaks a seating rule, such as
a companion seat held without its access seat; the response names the rule.

The admin performance page, `/venues/<venueId>/performances/<performanceId>`,
shows held seats on the map and in the table. Refresh the page to update it.

## Status

Bootstrapping. See [docs/bootstrap.md](docs/bootstrap.md) for the full brief.

### Intents

- [monorepo-skeleton](intent/monorepo-skeleton/intent.md): workspace, apps, CI and Docker images.
- [venues-seat-maps](intent/venues-seat-maps/intent.md): venues, events and read-only seat maps in the admin app.
- [holds](intent/holds/intent.md): seat and GA holds with Temporal expiry timers.

## Licence

[Apache-2.0](LICENSE). All venues, events and people in fixtures are invented.
