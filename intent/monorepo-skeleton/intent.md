# Intent: monorepo skeleton

Status: draft
Originator: repo owner
Date: 2026-10-04

## Problem

The repo has its governance layer (CLAUDE.md, hooks, skills, agents, policy
skills, branch ruleset, environments) but no code. Nothing can be built,
tested or deployed:

- The five commands in CLAUDE.md (`pnpm typecheck`, `pnpm lint`, `pnpm test`,
  `pnpm test:int`, `pnpm db:check`) don't exist, so the dev/qa loop has
  nothing to run and the Stop-hook gate (`gate.sh`) is a no-op.
- There is no CI, so the `main` ruleset has no status checks to require and
  every merge relies on the owner's review alone.
- No app can be started, so later intents (venues and seat maps, holds,
  payments) would have to invent their own structure as they go.

This is also the first change through intent → spec → plan → implement →
ship. Part of the point is to find rough edges in the hooks and skills while
the change is trivial.

## Proposed outcome

A pnpm + Turborepo workspace matching the layout in `docs/bootstrap.md` §4,
where every app boots and every gate is real but no product behaviour exists.

**Workspace**
- Apps: `web`, `admin`, `scanner`, `api`, `worker`.
- Packages: `domain`, `db`, `contracts`, `config`.
- The commands in CLAUDE.md work: `pnpm typecheck`, `pnpm lint`,
  `pnpm test <path>`, `pnpm test:int`, `pnpm db:check`, `pnpm db:new <name>`,
  `pnpm temporal:dev`. They run against an empty domain.

**Bootable shells (each app starts and proves it runs, nothing more)**
- `api`: Fastify with a `/health` route whose response is validated by a Zod
  schema from `packages/contracts`.
- `web`, `admin`: Next.js, one placeholder page each.
- `scanner`: PWA shell (manifest + service worker registration), one page.
  No Dexie or sync library yet.
- `worker`: connects to Temporal and registers one no-op workflow.

**Tests**
- A unit test in `packages/domain`, so `pnpm test` has something to run.
- Testcontainers smoke test for Postgres: start a container, run the
  (empty) Drizzle migrations, query it.
- Worker smoke test against Temporal (dev server locally, Testcontainers in
  CI): start the no-op workflow and see it complete.

**CI/CD**
- `.github/workflows/ci.yml`: typecheck, lint, unit, integration jobs, plus
  a soak placeholder job that passes. Green on an empty PR.
- Deploy workflow: builds a Docker image per app, pushes it to GHCR, and
  deploys nothing. Pushing uses the workflow's `GITHUB_TOKEN` with
  `packages: write` (no stored secret), only for pushes to `main` and for PRs
  from branches in this repo; fork PRs build without pushing. Written
  by Claude as `.github/workflows/deploy.yml.proposed`; the owner reviews it
  and renames it to `deploy.yml` by hand (protect-paths blocks Claude from
  writing `deploy.yml`).
- Once CI has run, the owner adds its job names as required status checks
  on the `main` ruleset.

**Repo hygiene**
- `.env.example` with the variables the skeleton reads (e.g. `DATABASE_URL`,
  `TEMPORAL_ADDRESS`), using placeholder values only.
- `.github/pull_request_template.md`: links to intent/spec/plan plus an
  acceptance checklist.
- README updated with local setup steps, and this intent added to its
  Intents list. SECURITY.md already exists and stays unchanged.

## Affected users and systems

- **Engineers / Claude sessions**: get a working workspace, commands and
  gates. Every later intent builds on this structure.
- **Owner (reviewer)**: gets CI checks to require, and a PR template that
  links the artefact chain.
- **GitHub**: new workflows; the `main` ruleset gains required checks after
  this lands.
- **End users (venues, buyers, staff)**: none. No product behaviour and no
  personal or payment data.

## Constraints

- Stack as decided in `docs/bootstrap.md` §3: pnpm workspaces + Turborepo,
  Fastify, Zod contracts, Postgres + Drizzle, Temporal TypeScript SDK,
  Next.js, Vitest, Testcontainers, ESLint.
- Node 24 and pnpm 12.9 pinned in the repo (`engines`, `packageManager`,
  `.nvmrc`); CI reads its versions from those files rather than hard-coding
  them.
- Temporal hosting for deployed environments will be Temporal Cloud (free
  tier). The skeleton itself only uses the local dev server
  (`pnpm temporal:dev`) and Testcontainers in CI, but the worker reads its
  connection from env (`TEMPORAL_ADDRESS`, namespace, optional API key) so a
  Cloud connection needs no code change.
- The Stop-hook gate (`gate.sh`) goes live once the workspace exists: it
  must stay quick on Windows and must not block when `origin/main` is
  missing.
- Keep pipeline logic in pnpm scripts and keep the workflow YAML thin
  (portable to other CI later).
- Workflows use `pull_request`, never `pull_request_target` (public repo;
  fork PRs must get no secrets).
- The deploy workflow needs no secrets: it builds images only. It must not
  reference `FLY_API_TOKEN` or run `fly deploy`.
- `packages/db/migrations` is generated, never hand-edited (protect-paths
  enforces this).
- Money in `packages/domain` is integer pence. The skeleton has no amounts,
  but must not set a precedent that contradicts this.
- No real names, emails or venues anywhere, including placeholder pages and
  `.env.example`.
- Policy skills: this intent holds no personal or payment data, so both
  policy-pci and policy-gdpr should stay quiet at /spec. If policy-gdpr
  fires, its description is too broad and needs tuning.

## Out of scope

- `spec-on-intent.yml` and `claude-review.yml`: a separate, follow-up intent.
- Any real deployment: Fly apps, `fly.toml` behaviour beyond what's needed to
  build, Fly tokens, Fly secrets.
- Domain logic, database tables, auth, payments, Stripe.
- k6 soak test (the job is a placeholder until the reservation engine).
- Observability (OpenTelemetry, dashboards).
- The skill-eval CI job for policy skills (`docs/bootstrap.md` §8).
- The fake-PII lint rule (`docs/bootstrap.md` §9): postponed to a later
  intent, before the first fixtures or seed data with people in them.
- Setting up Temporal Cloud (account, namespace, secrets).
- Dexie / scanner sync: waits for the scanner intent.

## Open questions

1. **Required check names**: the exact CI job names become required checks
   on the `main` ruleset, so they're hard to rename later. Spec to propose
   them; owner confirms.
