# Plan: monorepo skeleton

Status: approved (owner accepted all recommendations Q1–Q6, 2026-10-05)
Intent: [intent.md](intent.md) · Spec: [spec.md](spec.md)
Date: 2026-10-05

Steps are ordered so that, from step 2 onwards, `pnpm typecheck`, `pnpm lint`
and `pnpm test` stay green after every step. `gate.sh` goes live the moment
`turbo.json` exists (F10), so it is fixed first (step 1). Each step lists the
spec ACs it covers so `/implement` can hand them to qa.

Steps marked **⚑Qn** depend on a resolved ambiguity below. The owner accepted
every recommendation on 2026-10-05; implement the recommended option.

## Decisions recorded in this plan

`docs/bootstrap.md` §1 says to record a decision in the plan wherever the brief
is silent.

| # | Decision | Why |
|---|---|---|
| P1 | Workspace packages are named `@boxoffice/<dir>`, e.g. `@boxoffice/domain` and `@boxoffice/api`. All are `"private": true`. | The brief gives no scope. A scope prevents clashes with npm names. |
| P2 | Temporal hosting for deployed environments is Temporal Cloud (free tier). The skeleton only needs the env vars from AC 9. | `bootstrap.md` §3 L52 says "decide in the skeleton plan". The intent's Constraints already chose Cloud, so this records that choice. |
| P3 | `lint` means ESLint only. Prettier runs through the format hook and is not a CI check. | The spec doesn't make formatting a check. Adding one would change the required-check surface (D6). |
| P4 | Dependency versions are the current stable major at install time and are pinned by the lockfile. The only versions written into config are Node and pnpm, in the files AC 5 names. | AC 5 |
| P5 | Root-level tests (repo and workflow checks) live in `test/repo/` and run as a `repo` Vitest project. | qa may write under `/test/` (qa-tests-only.sh). Workflow YAML can't be tested inside a package. |

## Ambiguities (resolved: owner accepted all recommendations, 2026-10-05)

**Q1 (accepted).** **How the CI jobs run "affected-only".** The spec defines
`pnpm ci:changed` as `turbo typecheck lint test --filter=...[<base>]`. That
conflicts with AC 14 and D6:
- AC 14 and D6 make `typecheck`, `lint` and `unit` separate jobs, each a
  single `pnpm …` script.
- AC 15 requires no filter on push to `main`.

One script can't run all three tasks and also act as three separate jobs.
**Recommendation:** `pnpm ci:changed <task>`. A small Node script,
`scripts/ci-changed.mjs`, picks the filter:
- `--filter=...[origin/main]` when `GITHUB_EVENT_NAME=pull_request`;
- no filter otherwise.

The jobs would then run `pnpm ci:changed typecheck`, `pnpm ci:changed lint`
and `pnpm ci:changed test`. This adds a `scripts/` directory that isn't in
`bootstrap.md` §4.

**Q2 (accepted).** **Worker integration test: when does it use the dev server and when does
it use Testcontainers?** The spec gives two different rules:
- AC 12 decides on whether `TEMPORAL_ADDRESS` *is set*.
- F2 and E2E step 2 decide on whether the dev server *is running*. E2E
  says: "stop the dev server and rerun: passes via Testcontainers".

If the variable is unset, the AC 12 rule never uses a running dev server. If
the variable is set, AC 12 fails when the server is stopped.
**Recommendation:** probe `TEMPORAL_ADDRESS ?? localhost:7233` with a 2 s
connect timeout. Use it if it is reachable, otherwise start Testcontainers.
CI has nothing listening on 7233, so it takes the Testcontainers path.

**Q3 (accepted).** **AC 7 requires `next build` to succeed, but none of the five CI jobs
builds anything.** The deploy workflow is only proposed, so nothing in CI
would catch a broken Next build. Unit tests can't start a server (spec Test
conventions).
**Recommendation:** `pnpm test:int` runs `turbo build --filter=./apps/*`
first, then Vitest. Per-app `serve.int.test.ts` tests then `next start` each
app and check the HTTP 200 response, the manifest and the `sw.js` route
(AC 7, AC 8). It stays one `pnpm` script, but the `integration` job gets
slower (roughly 2–3 min).
Alternative: add a `build` step to the `typecheck` job.

**Q4 (accepted).** **AC 5 says no other file hard-codes the Node version, but Dockerfiles
need a base image tag (`node:24-…`).**
**Recommendation:** use `ARG NODE_VERSION` with no default, so a build with
no argument fails loudly.
- `deploy.yml.proposed` passes `--build-arg NODE_VERSION=$(cat .nvmrc)`.
- Locally, run `docker build --build-arg NODE_VERSION=$(cat .nvmrc) …`. The
  README documents this, and a root `pnpm docker:build <app>` script wraps it.

pnpm inside the image comes from `packageManager` through corepack, so it
isn't hard-coded either.

**Q5 (accepted).** **Scanner icons.** AC 8 needs `icons` in the manifest. Claude's tools can
only write text files, so PNGs would need a generator dependency.
**Recommendation:** one SVG icon (`sizes: "any"`, `type: "image/svg+xml"`).
Real PNG icons can come with the scanner intent. `.gitattributes` needs no
change because SVG is text.

**Q6 (accepted).** **AC 6's "fails serialization" check.**
**Recommendation:** a unit test registers a route whose handler returns
`{ status: "nope" }` against `HealthResponse` and asserts a 500 response.
This tests the wiring, not the real handler.

Minor point, with no answer needed: AC 20 says "per-app `PORT`". There is one
variable name, so `.env.example` lists `PORT` once, with a comment giving
each app's default.

## Steps

### Step 1: make `gate.sh` safe before the workspace exists (D5, F10)

- **Files:**
  - `.claude/hooks/gate.sh`. This file is code-owned, so the owner reviews
    it.
- **Change:**
  - Directly after the `turbo.json` check, add the following: if
    `node_modules/.bin/turbo` is missing, or `pnpm` isn't on `PATH`, print
    `gate: workspace not installed (run pnpm install); skipping` to stderr
    and `exit 0`.
  - Keep the existing fallback chain when `origin/main` is missing:
    `origin/main` → `HEAD~1` → no filter.
- **Proof:** qa runs each of these from a temporary directory in the
  scratchpad:
  - `turbo.json` exists but `node_modules` doesn't: the gate exits 0 and
    prints the warning.
  - No `turbo.json`: the gate exits 0 silently.
  - A repo with no `origin` remote and a single commit: once a workspace
    exists, re-check in step 17.
- **ACs:** 25 (partly; fully verified in step 17).

### Step 2: root workspace, `packages/config` and `turbo.json`

- **Files:**
  - Root: `package.json`, `.nvmrc`, `pnpm-workspace.yaml`, `turbo.json`,
    `vitest.config.ts`, `vitest.int.config.ts`, `eslint.config.js`,
    `prettier.config.js`.
  - `pnpm-lock.yaml`, generated by `pnpm install`.
  - In `packages/config/`: `package.json`, `tsconfig.base.json`,
    `tsconfig.node.json`, `tsconfig.next.json`, `eslint.config.js` (flat
    config with node and next variants), `vitest.base.ts` and
    `prettier.config.js`.
- **Change:**
  - **`package.json`:**
    - `packageManager: pnpm@12.9.x`, using the exact patch version that is
      current at install, and `engines.node: 24.x`.
    - Scripts: `typecheck` and `lint` call `turbo …`.
      - `test` is `vitest run --config vitest.config.ts`, with `test.projects`
        set to `apps/*`, `packages/*` and `test/repo` and with `*.int.test.ts`
        excluded.
      - `test:int` is `vitest run --config vitest.int.config.ts`, which
        includes `**/*.int.test.ts` only. ⚑Q3 adds a build step in front of it
        in step 12.
      - `soak` prints the placeholder message and exits 0.
    - Root devDependencies:
      - `turbo`
      - `typescript`
      - `vitest`
      - `eslint`
      - `prettier`, which makes `format.sh` start working
  - **`turbo.json`:**
    - Tasks: `build`, `typecheck`, `lint`, `test` and `test:int`.
    - `test` has no dependency on `test:int` and nothing Docker-related.
    - `globalDependencies` lists the root config files (`turbo.json`,
      `package.json`, `pnpm-lock.yaml`, `tsconfig`/`eslint`/`vitest` bases,
      `.nvmrc`), which covers F3.
  - Every per-package `test` script uses `vitest run --passWithNoTests`, so a
    package with no tests yet stays green.
  - Run `pnpm install`. It isn't on the allow-list, so expect a permission
    prompt. This happens in the same step that writes `turbo.json`.
- **Proof:**
  - `pnpm install --frozen-lockfile`, then `pnpm typecheck`, `pnpm lint`,
    `pnpm test` and `pnpm soak` all exit 0.
  - A qa test, `test/repo/versions.test.ts`, asserts:
    - `packageManager` matches `pnpm@12.9.`;
    - `engines.node` is `24.x`;
    - `.nvmrc` is `24`;
    - no other tracked file contains `pnpm@12` or a `node:24`/`node-version: 24`
      literal.
- **ACs:** 5, and 1 (partly).

### Step 3: `packages/domain`

- **Files:** in `packages/domain/`: `package.json`, `tsconfig.json`,
  `vitest.config.ts`, `src/index.ts` and `src/result.ts`, with the test in
  `test/result.test.ts`.
- **Change:**
  - A `Result<T, E>` type with `ok`, `err` and `isOk` helpers.
  - No `number`-typed amount, price or fee fields (Money precedent).
  - Do **not** create `money.ts` (spec non-goal; concern 6).
- **Proof:**
  - `pnpm test packages/domain` runs only `result.test.ts` and passes.
  - The output lists no other project's files.
- **ACs:** 2, and 1 (partly).

### Step 4: `packages/contracts`

- **Files:** in `packages/contracts/`: `package.json`, `tsconfig.json`,
  `vitest.config.ts`, `src/index.ts`, `src/health.ts` and
  `test/health.test.ts`.
- **Change:** `HealthResponse = z.object({ status: z.literal("ok") }).strict()`.
- **Dependency:** `zod`, the contract library chosen in bootstrap §3.
- **Proof:** `pnpm test packages/contracts`:
  - `{status:"ok"}` parses;
  - extra keys are rejected;
  - a wrong `status` value is rejected.
- **ACs:** 6 (the contract half).

### Step 5: `packages/db` tooling and the generated `init` migration

- **Files:**
  - In `packages/db/`: `package.json`, `tsconfig.json`, `vitest.config.ts`,
    `drizzle.config.ts`, `src/schema.ts` (empty), `src/env.ts` (Zod-parsed
    `DATABASE_URL` with a placeholder default for tooling) and
    `src/migrate.ts` (`runMigrations(url)` using the Drizzle migrator on
    `./migrations`).
  - Root `package.json`:
    - `db:check` = `pnpm --filter @boxoffice/db exec drizzle-kit check`
    - `db:new` = `pnpm --filter @boxoffice/db exec drizzle-kit generate --name`
    - Trailing arguments pass through, so
      `pnpm db:new init --custom` runs `--name init --custom`.
  - `packages/db/migrations/**` is **generated only**. protect-paths blocks
    writing to it with Edit or Write.
- **Dependencies:**
  - `drizzle-orm` and `drizzle-kit` (bootstrap §3).
  - `postgres`, the driver the migrator needs.
- **Change:** run `pnpm db:new init --custom` (D2). Then run
  `pnpm db:new probe`. It should report no changes and write nothing.
- **Proof:**
  - `pnpm db:check` exits 0 without a database.
  - After `db:new probe`, `git status` shows nothing new under `migrations/`.
  - `migrations/` contains exactly `0000_init.sql` (empty, or drizzle's
    comment header) and `meta/_journal.json` plus the snapshot.
  - Unit test `packages/db/test/env.test.ts`: an invalid `DATABASE_URL` throws
    an error that names the variable and doesn't contain its value.
- **ACs:** 4, 11, 1 (`db:check`).
- **Risk:** if `drizzle-kit generate --custom` refuses to run against an empty
  schema, stop and report it. Do not hand-write the journal.

### Step 6: Postgres integration smoke test

- **Files:**
  - `packages/db/test/migrate.int.test.ts`, written by qa.
  - `test:int` wiring in `packages/db/package.json`.
- **Dependencies:** `testcontainers` and `@testcontainers/postgresql`
  (bootstrap §3).
- **Change:**
  - The test starts Postgres, calls `runMigrations(container URL)` and
    asserts `select 1` returns `1`.
  - It uses a generous startup timeout (F11).
  - If Docker is unreachable, it fails within about 10 s with
    `Docker is not running (required by pnpm test:int)` (F1).
- **Proof:**
  - `pnpm test:int` passes with Docker running.
  - With Docker stopped:
    - `pnpm test:int` fails fast with the Docker message;
    - `pnpm test` still passes (AC 3).
- **ACs:** 10, 3.

### Step 7: `apps/api`

- **Files:** in `apps/api/`:
  - `package.json`, `tsconfig.json` and `vitest.config.ts`.
  - Source: `src/env.ts` (`PORT`, default 4000), `src/app.ts`
    (`buildApp()` with the Zod validator and serializer compilers, and
    `GET /health` with `response: { 200: HealthResponse }`) and
    `src/index.ts` (listen).
  - Tests: `test/health.test.ts` and `test/env.test.ts`.
- **Dependencies:** `fastify` and `fastify-type-provider-zod` (bootstrap §3).
- **Proof:** `pnpm test apps/api` checks:
  - `inject` on `GET /health` returns 200, and `HealthResponse.parse(body)`
    passes;
  - a route with a deliberately wrong handler returns 500 (⚑Q6);
  - an invalid `PORT` fails, naming `PORT`.
  - Manual check: `pnpm --filter @boxoffice/api dev`, then
    `curl localhost:4000/health`.
- **ACs:** 6.

### Step 8: `apps/worker`

- **Files:** in `apps/worker/`:
  - `package.json`, `tsconfig.json` and `vitest.config.ts`.
  - Source:
    - `src/env.ts`: `TEMPORAL_ADDRESS` (default `localhost:7233`),
      `TEMPORAL_NAMESPACE` (default `default`), optional `TEMPORAL_API_KEY`.
    - `src/connection.ts`: builds connection options, adding TLS and the API
      key when the key is set.
    - `src/workflows.ts`: `noopWorkflow(): Promise<"ok">`.
    - `src/index.ts`: creates the worker on task queue `boxoffice`. It shuts
      down on SIGINT and SIGTERM. If it can't connect, it logs the address
      and exits non-zero (F2).
  - Tests: `test/env.test.ts` and `test/connection.test.ts`.
- **Dependencies:** `@temporalio/worker`, `@temporalio/workflow` and
  `@temporalio/client` (bootstrap §3).
- **Proof:** `pnpm test apps/worker` checks:
  - the defaults are applied;
  - with an API key set, the options have `tls: true` and the key;
  - with no key, there is no TLS;
  - an invalid value names the variable but not its value.
- **ACs:** 9. Signal handling is checked manually in step 17.

### Step 9: `pnpm temporal:dev` and the worker integration smoke test (⚑Q2)

- **Files:**
  - Root `package.json` (`temporal:dev`).
  - `apps/worker/test/noop.int.test.ts`, written by qa.
  - `apps/worker/test/temporal-target.ts`, the probe-or-container helper,
    which sits under `test/` so qa can write it.
- **Change:**
  - `temporal:dev` runs:
    `docker run --rm -p 7233:7233 -p 8233:8233 temporalio/temporal:<tag> server start-dev --ip 0.0.0.0`.
    This follows D3.
  - The integration test uses the same image tag. Put a comment in both
    places telling people to keep them in sync.
  - The test starts an in-process worker, runs `noopWorkflow` and asserts the
    result is `"ok"`.
- **Proof:**
  - With `pnpm temporal:dev` running, `pnpm test:int` passes through the dev
    server.
  - With it stopped, the test passes through Testcontainers. The log line
    should show which path it took.
- **ACs:** 12, and F2.

### Step 10: `apps/web` and `apps/admin`

- **Files**, the same set in each app:
  - `package.json`, `tsconfig.json`, `next.config.ts` (with
    `output: "standalone"`), `vitest.config.ts` and `eslint.config.js`.
  - `app/layout.tsx`, which renders `<html lang="en-GB">` and exports
    `metadata.title` and a `viewport` with no `maximumScale` and no
    `userScalable: false`.
  - `app/page.tsx`, which renders a single `<h1>`.
  - `test/page.test.tsx`.
- **Ports:** web uses 3000 and admin 3001. `next dev` and `next start` take
  them as `-p ${PORT:-…}` in the scripts.
- **Dependencies:** `next`, `react` and `react-dom` (bootstrap §3), plus
  `@testing-library/react` and `jsdom` for the unit tests.
- **Proof:** `pnpm test apps/web apps/admin`:
  - `renderToStaticMarkup` of the layout and page contains `lang="en-GB"`
    and exactly one `<h1`;
  - `metadata.title` is set;
  - the `viewport` doesn't disable zoom.
  - Separately, `pnpm --filter @boxoffice/web build` succeeds.
- **ACs:** 7 (unit half). The serve half is in step 12.

### Step 11: `apps/scanner`

- **Files:**
  - The same files as step 10, with port 3002.
  - `app/manifest.ts`, which Next serves as `/manifest.webmanifest`.
  - `public/icon.svg` (⚑Q5).
  - `public/sw.js`: install and activate handlers only, with no `fetch`,
    `caches` or sync code.
  - `app/register-sw.tsx`, a client component that calls
    `navigator.serviceWorker.register("/sw.js")` on load.
  - Tests: `test/manifest.test.ts` and `test/register-sw.test.tsx`.
- **Proof:** `pnpm test apps/scanner`:
  - the manifest has `name`, `start_url`, `display` and a non-empty `icons`;
  - `register` is called with `/sw.js`, using a mocked
    `navigator.serviceWorker`;
  - a static check on `sw.js` finds no `fetch`, `caches.` or `sync`.
- **ACs:** 8, 7.

### Step 12: Next serve smoke tests (⚑Q3)

- **Files:**
  - Root `package.json`: `test:int` becomes
    `turbo build --filter=./apps/* && vitest run --config vitest.int.config.ts`.
  - Tests, written by qa: `apps/{web,admin,scanner}/test/serve.int.test.ts`.
- **Change:** each test runs `next start` on a free port and expects:
  - `GET /` returns 200 and the HTML contains `lang="en-GB"`;
  - for the scanner, `GET /manifest.webmanifest` and `GET /sw.js` also
    return 200.
- **Proof:** `pnpm test:int` passes.
- **ACs:** 7, 8.

### Step 13: Dockerfiles (⚑Q4)

- **Files:**
  - `apps/{api,web,admin,scanner,worker}/Dockerfile`.
  - Root `.dockerignore`.
  - Root `package.json`: `docker:build`, a small script in
    `scripts/docker-build.mjs` that reads `.nvmrc` and runs
    `docker build -f apps/<app>/Dockerfile --build-arg NODE_VERSION=… -t boxoffice-<app>:local .`.
- **Change:** a multi-stage build:
  - `turbo prune @boxoffice/<app> --docker`;
  - install from the pruned lockfile;
  - build;
  - a slim runtime stage.
  - The Next apps use the `standalone` output.
  - Don't use `--force` anywhere, because guard-bash blocks it.
- **Proof:** `pnpm docker:build <app>` succeeds for all 5 apps. `docker`
  will prompt for permission. Then:
  - `docker run` of the api image answers `/health`.
- **ACs:** 19.

### Step 14: CI workflow (⚑Q1)

- **Files:**
  - `scripts/ci-changed.mjs` and root `package.json` (`ci:changed`).
  - `.github/workflows/ci.yml`, which is code-owned.
  - Test, written by qa: `test/repo/ci-workflow.test.ts`.
- **Change:**
  - Triggers: `pull_request`, and `push` on branch `main`. No `paths` filter.
  - Five jobs with exactly these ids and names: `typecheck`, `lint`, `unit`,
    `integration`, `soak`. No matrix.
  - Each job does checkout, `pnpm/action-setup` (version taken from
    `packageManager`), `actions/setup-node` with `node-version-file: .nvmrc`
    and pnpm cache, then `pnpm install --frozen-lockfile`.
  - Run steps:
    - `typecheck`: `pnpm ci:changed typecheck`
    - `lint`: `pnpm ci:changed lint`
    - `unit`: `pnpm ci:changed test`
    - `integration`: `pnpm test:int`
    - `soak`: `pnpm soak`
  - Use `fetch-depth: 0` where the filter is used.
  - Permissions: `contents: read`.
- **Proof:**
  - The workflow test parses the YAML and asserts:
    - AC 13: no `pull_request_target`, no `secrets.`, no workflow-level
      `paths`;
    - AC 14: the job set is exact, there's no `strategy.matrix`, and each run
      step is a single `pnpm …`.
  - `scripts/ci-changed.mjs` exports a pure `buildArgs(env, task)`.
    `test/repo/ci-changed.test.ts` checks:
    - a PR event produces `--filter=...[origin/main]`;
    - a push produces no filter (AC 15, F4).
  - **AC 16:** on a scratch branch, change only `turbo.json`, commit, and run
    `pnpm turbo run typecheck --filter='...[HEAD~1]' --dry=json`. Assert that
    every package is listed. If turbo doesn't cover this through
    `globalDependencies`, report it and don't paper over it.
  - **AC 17:** a docs-only PR is green, confirmed on the real PR in step 17.
- **ACs:** 13–17.

### Step 15: `deploy.yml.proposed`

- **Files:**
  - `.github/workflows/deploy.yml.proposed`. protect-paths blocks `deploy.yml`,
    and the owner renames it by hand.
  - Test, written by qa: `test/repo/deploy-workflow.test.ts`.
- **Change:**
  - Triggers: `pull_request`, and `push` on `main`.
  - Permissions: `contents: read` and `packages: write`. No `environment:`.
  - A job for each app. To keep it thin, a matrix is allowed here, because
    these aren't required checks.
  - `docker/setup-buildx-action`, then `docker/login-action` with
    `GITHUB_TOKEN`, with login and push conditional on
    `github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository`.
  - The image is `ghcr.io/${owner,,}/boxoffice-<app>`, lowercased in a shell
    step (F7).
  - The tag is `github.event.pull_request.head.sha || github.sha`, so it
    matches the commit the author sees.
  - Build arg: `NODE_VERSION` taken from `.nvmrc`.
- **Proof:** the test asserts:
  - the permissions are exact;
  - there's no `FLY_API_TOKEN`, no `fly`, and no `environment`;
  - the only `secrets.` reference is `secrets.GITHUB_TOKEN`;
  - the push condition is present;
  - the owner is lowercased;
  - `deploy.yml` doesn't exist.
- **ACs:** 18.

### Step 16: hygiene

- **Files:**
  - `.env.example`:
    - `PORT`, commented with each app's default;
    - `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` and `TEMPORAL_API_KEY`, with
      placeholder values only;
    - `DATABASE_URL`.
  - `.github/pull_request_template.md`.
  - `README.md`:
    - a Local setup section: prerequisites Node 24, pnpm via corepack and
      Docker; then `pnpm install`, `pnpm temporal:dev`, and a table of
      commands;
    - a link to this intent under Intents.
  - `SECURITY.md` stays unchanged.
  - Test, written by qa: `test/repo/env-example.test.ts`.
- **Proof:**
  - The test collects every `process.env.X` and Zod env key across
    `apps/*/src` and `packages/*/src`, and asserts the set equals the keys in
    `.env.example` (AC 20).
  - The reviewer checks AC 21–23 by reading the files. The test also asserts
    that `SECURITY.md` matches `main` (`git diff --quiet main -- SECURITY.md`).
- **ACs:** 20–23.

### Step 17: end-to-end verification (no new code)

- `git clone` into the scratchpad, then:
  - `pnpm install --frozen-lockfile`;
  - `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm db:check`;
  - `pnpm test:int`, both with the dev server up and with it down;
  - `pnpm docker:build` for each app.
- Gate checks:
  - AC 24: time `.claude/hooks/gate.sh` after a one-file change in
    `packages/domain` with a warm turbo cache. It must take under 60 s.
  - AC 25: run the gate in the clone after `git remote remove origin`. It
    must exit 0.
- Worker shutdown: start the worker against the dev server and send Ctrl+C.
  It must exit cleanly with code 0 (AC 9).
- The spec's E2E steps 3 and 5 (browser DevTools service-worker check, GHCR
  push, ruleset) are **owner-only** and listed in the PR body.
- **ACs:** 1, 9, 24, 25. Every other AC is checked again here.

## AC coverage

| AC | Step | AC | Step | AC | Step |
|---|---|---|---|---|---|
| 1 | 2–5, 17 | 10 | 6 | 19 | 13 |
| 2 | 3 | 11 | 5 | 20 | 16 |
| 3 | 6 | 12 | 9 | 21 | 16 |
| 4 | 5 | 13 | 14 | 22 | 16 |
| 5 | 2 | 14 | 14 | 23 | 16 (review) |
| 6 | 4, 7 | 15 | 14 | 24 | 17 |
| 7 | 10–12 | 16 | 14 | 25 | 1, 17 |
| 8 | 11, 12 | 17 | 14, 17 | | |
| 9 | 8, 17 | 18 | 15 | | |

## Notes for /implement

- **Permission prompts:** `pnpm install`, `pnpm dlx`, `docker` and
  `pnpm temporal:dev` aren't on the allow-list, so expect prompts. The
  allow-list has only `Bash(...)` rules and no PowerShell equivalents.
- **Blocked commands:** guard-bash blocks any `--force` and any `rm -rf`. Use
  `git clean` or scratchpad directories instead of deleting trees.
- **Who writes what:**
  - qa can only write test paths (`/test/`, `*.test.ts(x)`), so the
    workflows, Dockerfiles and Vitest configs belong to dev.
  - dev writes `*.int.test.ts` only when a step needs one in order to compile.
- **Policy skills:** none apply (spec concern 8). policy-pci and policy-gdpr
  stay quiet. The placeholder pages and the `.env.example` contain no people.
