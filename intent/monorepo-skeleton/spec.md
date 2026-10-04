# Spec: monorepo skeleton

Status: draft (owner decisions recorded 2026-10-05)
Intent: [intent.md](intent.md)
Date: 2026-10-04

## Goal

Turn the governance-only repo into a pnpm + Turborepo workspace (layout per
`docs/bootstrap.md` §4) in which every app boots, every command in CLAUDE.md
runs, CI produces stable checks the `main` ruleset can require, and a build-only
deploy workflow is ready for the owner to adopt. No product behaviour.

## Non-goals

- Product behaviour of any kind: domain logic, tables, auth, payments, Stripe,
  `packages/domain/money.ts`, `packages/domain/reservation`.
- Any deployment: no `infra/fly/`, no `fly.toml`, no Fly tokens or secrets.
- `spec-on-intent.yml`, `claude-review.yml` (follow-up intent).
- k6 soak (placeholder job only), observability, policy-skill eval job,
  fake-PII lint rule, Temporal Cloud setup, Dexie / scanner sync.
- Local Postgres for running apps (`docker compose` etc.): nothing in the
  skeleton reads a database at runtime. Tests bring their own via
  Testcontainers.
- Cleanup / retention of GHCR images.

## Design

### Workspace

| Path | What | Notes |
|---|---|---|
| `package.json` | root scripts, `packageManager: pnpm@12.9.x`, `engines.node: 24.x` | scripts below |
| `.nvmrc` | `24` | CI reads it via `node-version-file` |
| `pnpm-workspace.yaml` | `apps/*`, `packages/*` | |
| `turbo.json` | tasks `build`, `typecheck`, `lint`, `test`, `test:int` | `test` must not depend on Docker |
| `packages/config` | shared `tsconfig` bases, ESLint flat config, Vitest base config, Prettier config | tooling only, no runtime code |
| `packages/contracts` | Zod schemas; first one: `HealthResponse` | |
| `packages/domain` | empty domain + one pure helper with a unit test | see "Money precedent" |
| `packages/db` | Drizzle config, empty `schema.ts`, `migrations/`, migrate helper | see Data model impact |
| `apps/api` | Fastify + Zod type provider, `GET /health` | |
| `apps/web`, `apps/admin` | Next.js, one placeholder page each | |
| `apps/scanner` | Next.js, one page, `manifest.webmanifest`, service worker registered on load | decision D4 |
| `apps/worker` | Temporal worker, one no-op workflow | |

Prettier is installed at the root so `.claude/hooks/format.sh` (which no-ops
until `node_modules/.bin/prettier` exists) starts formatting.

### Root scripts (the CLAUDE.md contract)

| Command | Behaviour |
|---|---|
| `pnpm typecheck` | `turbo typecheck` (all packages) |
| `pnpm lint` | `turbo lint` |
| `pnpm test [path]` | Vitest unit run across the workspace (projects config); a path argument narrows it. Excludes `*.int.test.ts`. |
| `pnpm test:int` | Vitest run of `*.int.test.ts` only (Testcontainers / Temporal) |
| `pnpm db:check` | `drizzle-kit check` in `packages/db` (no database needed) |
| `pnpm db:new <name>` | `drizzle-kit generate --name <name>` in `packages/db`; `pnpm db:new <name> --custom` passes through for an empty custom migration |
| `pnpm temporal:dev` | runs the `temporalio/temporal` Docker image with `server start-dev`: `localhost:7233`, UI on `:8233` (decision D3) |
| `pnpm soak` | prints that soak is a placeholder until the reservation engine; exits 0 |
| `pnpm ci:changed` | `turbo typecheck lint test --filter=...[<base>]`, used by CI and matching `gate.sh` |

Per-package scripts `typecheck`, `lint`, `test`, `test:int` exist where they
have something to run, so turbo's graph (and `gate.sh`) works per package.

### Test conventions

- Unit: `*.test.ts`, colocated or under `test/`; no network, no Docker.
- Integration: `*.int.test.ts`; may start containers; only run by
  `pnpm test:int`.
- `turbo test` (used by `gate.sh`) runs unit tests only, so the Stop hook
  never waits on Docker.

### Money precedent

The skeleton has no amounts. The `packages/domain` unit test must exercise a
non-monetary helper (e.g. a `Result` or branded-id helper). No `number`-typed
price, amount or fee field appears anywhere, including placeholder pages and
contracts.

## Acceptance criteria (testable)

Workspace and commands
1. On a clean clone with Node 24 and pnpm 12.9: `pnpm install --frozen-lockfile`
   succeeds and each of `pnpm typecheck`, `pnpm lint`, `pnpm test`,
   `pnpm db:check` exits 0.
2. `pnpm test packages/domain` runs only the domain tests and passes; there is
   at least one test.
3. `pnpm test` does not start any container (verified by running it with
   Docker stopped).
4. `pnpm db:new probe` generates via drizzle-kit (with an empty schema it
   reports no changes and writes nothing); the command exists and exits 0.
   No file under `packages/db/migrations` is hand-written (see AC 11).
5. `package.json` has `packageManager` (pnpm 12.9.x) and `engines.node`
   (24.x); `.nvmrc` says 24. No other file hard-codes these versions.

Apps
6. `api`: `GET /health` returns 200 with a body that `HealthResponse.parse`
   accepts (`{ "status": "ok" }`). A unit test uses Fastify `inject`. A
   response that doesn't match the schema fails serialization (unit test with
   a deliberately wrong handler, or schema test).
7. `web`, `admin`, `scanner`: `next build` succeeds and the dev server serves
   the placeholder page with HTTP 200. Each page has `<html lang="en-GB">`, a
   `<title>`, one `<h1>`, and a viewport meta that does not disable zoom
   (interim accessibility baseline, decision D1).
8. `scanner`: serves `manifest.webmanifest` (name, start_url, display,
   icons) and registers a service worker; the SW does no caching or sync
   beyond what registration requires.
9. `worker`: reads `TEMPORAL_ADDRESS` (default `localhost:7233`),
   `TEMPORAL_NAMESPACE` (default `default`) and optional `TEMPORAL_API_KEY`
   (when set: TLS on, API-key auth), registers `noopWorkflow` on task queue
   `boxoffice`, and shuts down cleanly on SIGINT/SIGTERM. Pointing it at Cloud
   needs only env changes.

Tests
10. `pnpm test:int` includes a Postgres smoke test: Testcontainers starts
    Postgres, the Drizzle migrator applies `packages/db/migrations`, and
    `select 1` returns 1.
11. `packages/db/migrations` contains only drizzle-kit output: one empty
    custom migration `init`, generated with `pnpm db:new init --custom`, plus
    the journal the migrator requires (decision D2). Nothing hand-written.
12. `pnpm test:int` includes a worker smoke test: start `noopWorkflow`, await
    its result, assert it completed. It uses `TEMPORAL_ADDRESS` when set (local
    `pnpm temporal:dev`), otherwise starts Temporal via Testcontainers. CI
    takes the Testcontainers path.

CI/CD
13. `.github/workflows/ci.yml` triggers on `pull_request` and `push` to
    `main`; it contains no `pull_request_target`, no `secrets.*`, and no
    workflow-level `paths` filter (a required check must always report).
14. Jobs and their names are exactly `typecheck`, `lint`, `unit`,
    `integration`, `soak` (confirmed by owner, decision D6). No matrix on these
    jobs, so names stay stable. Each job's run step is a single `pnpm …`
    script.
15. On PRs, `typecheck`, `lint`, `unit` run affected-only against
    `origin/main` (checkout with enough history). On push to `main` they run
    unfiltered, so `main` is always fully checked.
16. A PR touching only a root config file (e.g. `turbo.json`) runs the
    checks for all packages, not none (Failure mode F3).
17. A PR containing no code change is green on all five jobs.
18. `.github/workflows/deploy.yml.proposed` exists; `deploy.yml` does not.
    It builds one Docker image per app (`apps/<app>/Dockerfile`, using
    `turbo prune --docker`) and pushes to
    `ghcr.io/<lowercased owner>/boxoffice-<app>` tagged with the commit SHA.
    Permissions: `contents: read`, `packages: write`. Push happens only on
    `push` to `main` and on PRs where
    `github.event.pull_request.head.repo.full_name == github.repository`;
    fork PRs build without pushing. No `FLY_API_TOKEN`, no `fly`, no
    `environment:`, no secret other than `GITHUB_TOKEN`.
19. `docker build` of each app's image succeeds locally.

Hygiene
20. `.env.example` lists exactly the variables the skeleton reads
    (`DATABASE_URL` for `db` tooling, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`,
    `TEMPORAL_API_KEY`, per-app `PORT`), with placeholder values only.
21. `.github/pull_request_template.md` has links for intent, spec and plan and
    an acceptance-criteria checklist section.
22. README has local setup steps (install, `pnpm temporal:dev`, the commands
    table) and lists this intent under Intents. SECURITY.md unchanged.
23. No real names, emails, phone numbers or venues in any added file.

Gate
24. With the workspace installed, `gate.sh` completes in under 60 s on the
    owner's Windows machine for a one-file change in `packages/domain`, warm
    turbo cache.
25. `gate.sh` exits 0 (does not block) when `origin/main` is missing and when
    `node_modules` is absent, printing a warning in the latter case
    (decision D5).

## Data model impact

None. `packages/db` has an empty `schema.ts`, `drizzle.config.ts`, and one
empty generated `init` migration plus its journal, so the migrator runs
(decision D2). No tables. No tables, no outbox yet.

## Interfaces

**HTTP (api)**

| Method | Path | Response | Contract |
|---|---|---|---|
| GET | `/health` | `200 { "status": "ok" }` | `HealthResponse` in `packages/contracts` |

`HealthResponse` deliberately carries no version, hostname or dependency
status: it's public and unauthenticated. Readiness checks (DB, Temporal) come
with the first intent that has those dependencies.

**Temporal (worker)**: task queue `boxoffice`; workflow `noopWorkflow(): Promise<"ok">`; no activities.

**Environment**

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `PORT` | api, web, admin, scanner | api 4000, web 3000, admin 3001, scanner 3002 | |
| `TEMPORAL_ADDRESS` | worker, worker int test | `localhost:7233` | |
| `TEMPORAL_NAMESPACE` | worker | `default` | |
| `TEMPORAL_API_KEY` | worker | unset | set = TLS + API key (Temporal Cloud) |
| `DATABASE_URL` | `packages/db` drizzle config | placeholder | not read by any app yet; the int test uses its container's URL |

Env is parsed with Zod at startup in each app; an invalid value fails fast
with the variable name (never its value).

**Docker images**: `ghcr.io/<owner-lowercase>/boxoffice-{api,web,admin,scanner,worker}:<sha>`.

## Failure modes

| # | Failure | Handling |
|---|---|---|
| F1 | Docker not running locally | `pnpm test` unaffected (AC 3); `pnpm test:int` fails fast with a message naming Docker |
| F2 | Temporal dev server not running | worker int test falls back to Testcontainers; worker process logs the address and exits non-zero |
| F3 | Turbo's `[origin/main]` filter treats a root-only change as "no packages changed", so CI and the gate pass vacuously | AC 16; if turbo doesn't cover it, list root config files in turbo `globalDependencies` |
| F4 | Push to `main` with the PR filter would compare `main` to itself and check nothing | AC 15: unfiltered on push |
| F5 | Required check name changes after the ruleset references it: PRs hang on "expected" | names fixed now (D6); no matrix |
| F6 | Path-filtered workflow skips, required check never reports | AC 13: no workflow-level path filter |
| F7 | GHCR rejects mixed-case owner (`Orlando80`) | lowercase in the workflow (AC 18) |
| F8 | Fork PR tries to push images | condition in AC 18; `pull_request` token is read-only for forks anyway |
| F9 | Drizzle migrator throws on a migrations folder with no journal | generated empty `init` migration (D2) |
| F10 | Gate blocks every Stop mid-implementation once `turbo.json` exists but packages are half-built | plan orders the `turbo.json` step deliberately (D5) |
| F11 | Testcontainers on Windows (Docker Desktop) slower or flakier than on CI | int tests aren't part of the gate; generous startup timeouts |

## End-to-end verification step

On a clean clone on the owner's Windows machine:

1. `pnpm install --frozen-lockfile`, then `pnpm typecheck`, `pnpm lint`,
   `pnpm test`, `pnpm db:check`: all exit 0.
2. `pnpm temporal:dev` in one terminal; `pnpm test:int` in another: Postgres
   and worker smoke tests pass. Stop the dev server and rerun: the worker test
   passes via Testcontainers.
3. Start `api` and run `curl localhost:4000/health`: `{"status":"ok"}`.
   Start `web`, `admin`, `scanner`: each page loads; scanner's manifest is
   served and a service worker shows as registered in DevTools.
4. `docker build` each app's image.
5. Open the PR: all five CI jobs go green. Then the owner renames
   `deploy.yml.proposed` → `deploy.yml` on a branch and confirms images
   appear in GHCR for a same-repo PR, then adds the five job names as
   required checks on ruleset `main`.

## Flagged concerns

1. **Missing policy skills.** `/spec` names policy-accessibility and
   policy-uk-refunds; neither exists in `.claude/skills/`. policy-uk-refunds
   has nothing to apply to here. policy-accessibility *would* apply to the
   three placeholder pages (customer-facing UI per the brief's trigger). As an
   interim step this spec takes a minimal baseline from the brief's
   accessibility row (AC 7: lang, title, h1, zoomable viewport); full WCAG 2.2
   AA waits for the skill. Owner to decide: author the two skills as their own
   intents (brief §6), or drop them from `/spec` until they exist.
2. **"Run the (empty) Drizzle migrations".** With an empty schema
   `drizzle-kit generate` writes nothing, and the migrator throws without
   `meta/_journal.json`. Options: (a) generate an empty custom migration
   through tooling (`drizzle-kit generate --custom --name init`, exposed as a
   flag on `pnpm db:new`) so a journal exists; (b) have the smoke test skip
   the migrator when there is no journal. Recommend (a): it's generated, not
   hand-edited, and it exercises the real migrate path. Needs owner OK since
   it puts the first file under `packages/db/migrations`.
3. **How `pnpm temporal:dev` gets a server.** The Temporal CLI isn't a
   prerequisite today, and `guard-bash.sh` blocks the usual
   `curl … | sh` installer. Options: (a) run the `temporalio/temporal` Docker
   image with `server start-dev` (Docker already required for
   Testcontainers); (b) require the Temporal CLI installed by hand (winget /
   brew). Recommend (a): no new prerequisite, same image as the CI path.
4. **Scanner framework.** The brief says "PWA" without a framework. Recommend
   Next.js like web/admin (one build and Docker pattern). Alternative: Vite +
   static server image. Owner to confirm; the Dexie intent may prefer Vite.
5. **`gate.sh` needs two fixes before it goes live** (intent constraint: quick
   on Windows, must not block). It already no-ops without `turbo.json` and
   handles a missing `origin/main`. But (a) with `turbo.json` present and no
   `node_modules`, `pnpm turbo` fails and the gate blocks every Stop; it
   should exit 0 with a warning. (b) During `/implement`, the gate goes live
   the moment `turbo.json` is written, so ordering matters (F10). Both belong
   in the plan as an explicit step. `.claude/` is code-owned, so the
   owner reviews that change.
6. **CLAUDE.md references `packages/domain/money.ts`**, and the reviewer agent
   checks "no money arithmetic outside money.ts". The skeleton deliberately
   doesn't create it (no domain logic). Harmless, but the pointer dangles
   until the first payments intent.
7. **Deploy workflow diverges from the brief.** Brief §8 has deploy.yml doing
   preview/staging/prod Fly deploys with environments. The intent narrows it
   to build-and-push only. That's per the intent and not a conflict, but the
   staging "CI green" gate (memory: must be `needs:` in deploy.yml) is not
   implemented here. It belongs to the first real-deploy intent.
8. **Policy check result.** policy-pci: not triggered (no payment data).
   policy-gdpr: not triggered (no personal data; no fixtures or seed data with
   people). Both stayed quiet, as the intent expects.
9. **Rough edge in `/spec` itself.** The skill text says to apply four policy
   skills unconditionally, which pushes the spec writer to mention all of
   them even when out of scope. Consider rewording to "apply whichever policy
   skills' triggers match; list those that don't and why".

## Decisions (owner, 2026-10-05)

The owner accepted the recommendations in Flagged concerns 1–5 and the
proposed check names.

| # | Decision |
|---|---|
| D1 | Placeholder pages meet the interim accessibility baseline in AC 7. Whether to author policy-accessibility / policy-uk-refunds or drop them from `/spec` stays open, outside this spec. |
| D2 | `packages/db/migrations` gets one empty custom migration `init`, generated by `pnpm db:new init --custom`, so the migrator runs for real. |
| D3 | `pnpm temporal:dev` runs the `temporalio/temporal` Docker image (`server start-dev`). No Temporal CLI prerequisite. |
| D4 | Scanner uses Next.js, like web and admin. |
| D5 | `gate.sh` exits 0 with a warning when `node_modules` is missing; the plan has an explicit step for this change and orders the `turbo.json` step so the gate doesn't block mid-implementation. |
| D6 | Required check names: `typecheck`, `lint`, `unit`, `integration`, `soak`, all required from the start, source pinned to GitHub Actions. |
