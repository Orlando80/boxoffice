# Boxoffice — AI-native SDLC bootstrap

4 Oct 2026 · @Orlando80

> This is the original bootstrap brief, kept as written. Where the
> implementation departs from it (for example hook fixes found while
> bootstrapping), the change is recorded in the commit that makes it.

## 1. Purpose

This doc is the brief for scaffolding Boxoffice, a project built to run Anthropic's AI-native SDLC end to end: intent → spec → plan → implement → ship → maintain, with Claude Code subagents, hooks, skills and CI as the machinery. Hand it to Claude Code in an empty repo and ask it to create the governance layer in sections 5–7 by hand first, then run the first intent in section 11.

Working rules for Claude Code reading this:

- Build the governance layer (CLAUDE.md, settings.json, hooks, skills, agents, workflows) exactly as specified before any product code.
- Everything after that goes through the SDLC: no feature without an `intent/<slug>/` folder.
- Where this doc is silent, prefer the simplest option and record the decision in the relevant plan.md.

## 2. Product: box-office and ticket inventory for mid-size venues

A multi-tenant platform for venues in the 500–5,000 capacity range: reserved and general-admission seating, timed on-sales, holds and allocations (press, sponsor, access seats), price tiers, waitlists, refunds and exchanges, door scanning, and finance reconciliation.

Why this product: on-sale is a real contention problem (idempotent reservations, expiring holds, duplicate webhooks); money is integer pence with partial refunds across fees; exchanges are compensating transactions; the scanner must work offline. There are several non-engineering originators (box-office manager, finance, marketing, front-of-house) and policy constraints with teeth (PCI, GDPR, accessibility, UK refund rules), which is what the SDLC's intent/spec stages and policy skills are for.

Scope ladder, each rung producing several intents:

1. Seat maps, events, holds, GA sales via a payment sandbox, confirmation emails.
2. Reserved seating with a race-safe reservation engine, waitlists, price tiers.
3. Refunds and exchanges, finance reconciliation and settlement exports.
4. Scanner app with offline sync.
5. Multi-tenant hardening, GDPR tooling, reporting.

Out of scope for now: dynamic pricing algorithms, secondary-market resale, marketing automation, payouts to third parties.

## 3. Stack and decisions

Decided: TypeScript monorepo, Temporal for workflows, Fly.io for hosting, public repo from day one.

| Concern | Choice | Notes |
|---|---|---|
| Workspace | pnpm workspaces + Turborepo | Task graph, caching, `--filter=...[origin/main]` for affected-only runs |
| API | Fastify | Zod schemas from packages/contracts validate every route |
| Contracts | Zod in packages/contracts | Single source of truth shared by api, web, admin, scanner |
| Database | Postgres + Drizzle | Reservation engine in explicit SQL (`SELECT ... FOR UPDATE SKIP LOCKED`), outbox table for events |
| Workflows and jobs | Temporal (TypeScript SDK) | Hold expiry timers, settlement runs, exchange sagas; apps/worker hosts workers |
| Payments | Stripe test mode | Tokenised only; webhooks must be idempotent |
| Web and admin | Next.js | Purchase flow and back office |
| Scanner | PWA, local-first (Dexie; PowerSync or Replicache if proper sync is needed) | Must validate tickets offline |
| Tests | Vitest, fast-check, Testcontainers (Postgres, Temporal), Playwright | Property tests mandatory on reservation code |
| Observability | OpenTelemetry, structured logs | One dashboard: oversells, hold-expiry lag, webhook failure rate |
| Hosting | Fly.io (Railway acceptable for previews) | Preview per PR, staging on main, prod on tag |
| Temporal hosting | Temporal Cloud free tier, or self-hosted on Fly | Decide in the skeleton plan |
| Licence | Apache-2.0 | Public repo |

## 4. Repo layout

```
boxoffice/
├── CLAUDE.md
├── LICENSE                        # Apache-2.0
├── SECURITY.md
├── CODEOWNERS                     # intent/, .claude/, packages/db/migrations → owner
├── intent/                        # one folder per change: intent.md, spec.md, plan.md
├── .claude/
│   ├── settings.json
│   ├── hooks/
│   │   ├── protect-paths.sh       # PreToolUse Edit|Write
│   │   ├── guard-bash.sh          # PreToolUse Bash
│   │   └── gate.sh                # Stop
│   ├── skills/
│   │   ├── intent/  spec/  plan/  implement/  ship/
│   │   └── policy-pci/  policy-gdpr/  policy-accessibility/  policy-uk-refunds/
│   └── agents/
│       ├── dev.md  qa.md  reviewer.md
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                 # typecheck, lint, unit, int, soak (placeholder)
│   │   ├── spec-on-intent.yml     # intent merged → /spec PR
│   │   ├── claude-review.yml      # read-only review comments
│   │   └── deploy.yml             # Fly preview per PR, staging on main, prod on tag
│   └── pull_request_template.md   # links to intent/spec/plan + acceptance checklist
├── apps/
│   ├── web/  admin/  scanner/  api/  worker/
├── packages/
│   ├── domain/  db/  contracts/  config/
├── infra/fly/                     # one fly.toml per app
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

Nested `.claude/skills/` directories are allowed inside `apps/*` and `packages/*` for package-specific conventions; Claude Code discovers them when working in those paths.

## 5. Governance files (write these first, by hand)

### CLAUDE.md

Keep under 40 lines. Everything else lives in skills.

```markdown
# Boxoffice — commands
- pnpm typecheck | pnpm lint | pnpm test <path> | pnpm test:int | pnpm db:check
- New migration: pnpm db:new <name>. Never hand-edit packages/db/migrations.
- Temporal dev server: pnpm temporal:dev (localhost:7233, UI :8233)

# Non-negotiables
- Money is integer pence (packages/domain/money.ts). No floats, no Number arithmetic on amounts.
- Card data never enters this codebase. Stripe tokens only. See /policy-pci.
- Reservation changes go through packages/domain/reservation; never raw seat updates.
- Public repo: no real names, emails or venues in fixtures; secrets only via Fly secrets / GH secrets.

# Workflow
- Every change starts in intent/<slug>/intent.md → spec.md → plan.md. See /intent, /spec, /plan.
- Policy skills (/policy-*) apply to all spec and design work.
- Prefer pnpm test <path> over the full suite while iterating.
- On compaction preserve: modified files, current plan step, test command.
```

### .claude/settings.json

```json
{
  "permissions": {
    "allow": [
      "Bash(pnpm typecheck)", "Bash(pnpm lint*)", "Bash(pnpm test*)",
      "Bash(pnpm db:check)", "Bash(pnpm db:new *)", "Bash(pnpm turbo *)",
      "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)",
      "Bash(git add *)", "Bash(git commit *)", "Bash(git checkout -b *)",
      "Bash(gh pr create *)", "Bash(gh pr view *)"
    ],
    "deny": [
      "Read(./.env*)", "Read(./infra/**/*.secret*)",
      "Bash(git push --force*)", "Bash(fly deploy*)", "Bash(fly secrets*)"
    ]
  },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": ".claude/hooks/protect-paths.sh" }] },
      { "matcher": "Bash",       "hooks": [{ "type": "command", "command": ".claude/hooks/guard-bash.sh" }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "pnpm exec prettier --write \"$CLAUDE_FILE_PATH\" >/dev/null 2>&1 || true" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": ".claude/hooks/gate.sh", "timeout": 600 }] }
    ]
  }
}
```

### .claude/hooks/protect-paths.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
path=$(jq -r '.tool_input.file_path // empty')
case "$path" in
  */packages/db/migrations/*) echo "Migrations are generated: run pnpm db:new <name> instead." >&2; exit 2 ;;
  */.env*|*/infra/*secret*)   echo "Secrets files are off-limits. Use fly secrets / GH secrets." >&2; exit 2 ;;
  */.github/workflows/deploy.yml) echo "deploy.yml changes require a human; describe the change instead." >&2; exit 2 ;;
esac
exit 0
```

### .claude/hooks/guard-bash.sh

Same shape: read `.tool_input.command` from stdin; exit 2 with a reason on `rm -rf`, `--force`, `fly `, `curl ... | sh`, or any production hostname. Exit 0 otherwise.

### .claude/hooks/gate.sh

```bash
#!/usr/bin/env bash
set -uo pipefail
out=$(pnpm turbo typecheck lint test --filter=...[origin/main] 2>&1)
if [ $? -ne 0 ]; then
  echo "Gate failed. Fix before finishing:" >&2
  echo "$out" | tail -60 >&2
  exit 2
fi
exit 0
```

Hook contract: JSON on stdin; exit 0 = proceed, exit 2 = block and feed stderr back to Claude. Make all three scripts executable and commit them.

### CODEOWNERS

```
/intent/                     @<owner>
/.claude/                    @<owner>
/packages/db/migrations/     @<owner>
/.github/workflows/          @<owner>
```

## 6. Skills

Workflow skills carry `disable-model-invocation: true` so only a human runs them. Policy skills use the default so Claude loads them when their description matches; their descriptions are written as trigger conditions.

### .claude/skills/intent/SKILL.md

```markdown
---
name: intent
description: Interview the originator and write an intent.md proto-spec
disable-model-invocation: true
---
Interview me about: $ARGUMENTS. Ask what can't be done today, who is affected,
what better looks like, and what is out of scope. Don't ask obvious questions.
Then write intent/<slug>/intent.md with: Problem, Proposed outcome,
Affected users and systems, Constraints, Open questions. Status: draft.
Mark anything I was vague about as an open question rather than resolving it.
Do not write any code.
```

### .claude/skills/spec/SKILL.md

```markdown
---
name: spec
description: Produce a requirements and design spec from an approved intent
disable-model-invocation: true
---
Read $ARGUMENTS (an intent.md). Produce intent/<slug>/spec.md: a requirements
and design spec for integrating this into the existing codebase. Apply the
policy-pci, policy-gdpr, policy-accessibility and policy-uk-refunds skills as
constraints. Sections: Goal, Non-goals, Acceptance criteria (testable),
Data model impact, Interfaces, Failure modes, End-to-end verification step,
Flagged concerns. Flag every policy conflict or point where the intent cannot
be satisfied; never resolve a conflict silently. Do not write code.
```

### .claude/skills/plan/SKILL.md

```markdown
---
name: plan
description: Produce an implementation plan from an approved spec
disable-model-invocation: true
---
Read $ARGUMENTS (a spec.md). Use subagents to explore the affected packages so
exploration stays out of this context. Write intent/<slug>/plan.md: ordered
steps, each naming the files it touches and the test that proves it. Flag any
step where the spec is ambiguous rather than guessing. Stop after writing the
plan; a human reviews it before implementation.
```

### .claude/skills/implement/SKILL.md

```markdown
---
name: implement
description: Implement an approved plan with independent QA and review
disable-model-invocation: true
---
Plan: $ARGUMENTS. Create branch feat/<slug> if not on it.
For each step in the plan:
1. Delegate to the `dev` subagent with the step text and the plan path.
2. Delegate to the `qa` subagent with dev's summary and the acceptance
   criteria. QA returns PASS with test output, or a defect list.
3. If defects: send them to `dev`, then back to `qa`. Max 3 rounds per step;
   if still failing, stop and report.
When all steps are done, delegate to the `reviewer` subagent to check the
full diff against the plan. Fix correctness gaps only; list anything else
as optional. Show the final test output, not a summary of it.
```

### .claude/skills/ship/SKILL.md

```markdown
---
name: ship
description: Commit and open a PR for an implemented plan
disable-model-invocation: true
---
Confirm the gate passes. Commit in conventional-commit units. Open a PR with
`gh pr create` whose body links intent.md, spec.md and plan.md and pastes the
spec's acceptance criteria as a checklist. Never push with --force.
```

### Policy skills

Each is 20–40 lines of concrete constraints, authored with the official skill-creator skill. Write policy-pci and policy-gdpr before the first product intent; policy-accessibility and policy-uk-refunds can arrive as intents of their own.

| Skill | Description (trigger) | Core rules |
|---|---|---|
| policy-pci | Use when designing anything that collects, stores, displays or transmits payment details | No PAN, CVV or expiry in code, logs, DB or tests; Stripe tokens and payment intents only; webhook signatures verified; test cards only from Stripe's published list |
| policy-gdpr | Use when designing anything that stores, displays or transmits attendee or customer personal data | Data minimisation; retention periods per field; erasure that pseudonymises personal data while retaining financial records for 6 years; export endpoint; no PII in logs or fixtures |
| policy-accessibility | Use when designing or reviewing any customer-facing UI or the seat-selection flow | WCAG 2.2 AA; keyboard-only purchase path; access-seat allocation rules; no colour-only state |
| policy-uk-refunds | Use when designing refunds, exchanges, cancellations or terms shown to customers | Consumer Rights Act and CMA guidance on cancelled or rescheduled events; refund of face value and booking fee on cancellation; terms surfaced before payment |

### Official skills to install

From the official marketplace: skill-creator (used to author the policy skills) and frontend-design (for the web apps).

## 7. Subagents

Hub-and-spoke: the main session orchestrates; subagents run in fresh context, return a result, and cannot spawn each other. Tool restrictions are the control, not the prompt.

### .claude/agents/dev.md

```markdown
---
name: dev
description: Implements a single plan step. Use for any task that writes or changes production code.
tools: Read, Edit, Write, Bash, Grep, Glob
model: sonnet
---
You are the implementer. Follow CLAUDE.md and the plan step you are given.
Make the smallest change that satisfies the step. Do not write tests beyond
what is needed to compile. Never add a dependency without stating why in your
summary. Return: files changed, how to exercise the change, open questions.
```

### .claude/agents/qa.md

```markdown
---
name: qa
description: Independently verifies a dev change against acceptance criteria. Writes and runs tests; never edits production code.
tools: Read, Grep, Glob, Bash, Write
model: sonnet
---
You are QA. You did not write the code and should assume it may be wrong.
Write tests under the package's test directory covering each acceptance
criterion plus edge cases. Run them with `pnpm test <path>`.
For anything under packages/domain/reservation: write a property-based test
with fast-check and a concurrency test that races at least 50 reservations
against one seat block. A PASS without these is not a PASS.
Return PASS with the test output, or a numbered defect list with
reproduction steps. Do not fix anything.
```

### .claude/agents/reviewer.md

```markdown
---
name: reviewer
description: Reviews a completed diff against its plan. Use after implementation, before shipping.
tools: Read, Grep, Glob, Bash
model: opus
---
Run `git diff main...HEAD`. Check against the plan you are given: every step
implemented, every listed edge case tested, nothing outside scope changed,
no money arithmetic outside packages/domain/money.ts, no PII in fixtures.
Report only gaps that affect correctness or stated requirements. Style and
hypothetical hardening are out of scope.
```

## 8. CI/CD, branch protection, environments, secrets

GitHub Actions is the primary. Keep pipeline logic in pnpm scripts so the YAML stays thin and portable to GitLab or Azure DevOps later.

### Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| ci.yml | every PR, push to main | `pnpm turbo typecheck lint test --filter=...[origin/main]`, then `pnpm test:int` with Testcontainers (Postgres, Temporal). A soak job exists from day one as a placeholder; once the reservation engine lands it runs k6 (500 carts at one seat block) and fails on any oversell |
| spec-on-intent.yml | push to main touching `intent/**/intent.md` | `claude -p "/spec intent/<slug>/intent.md" --permission-mode auto --allowedTools "Read,Grep,Glob,Write(intent/**),Bash(gh pr create *)"`; opens a PR adding spec.md |
| claude-review.yml | PR opened or updated | `anthropics/claude-code-action` with `allowed_tools: Read,Grep,Glob,Bash(pnpm test*)`; prompt restricted to correctness against the linked plan; comments only, cannot approve |
| deploy.yml | PR (preview), main (staging), tag v* (prod) | Docker build, fly deploy per app; prod requires the production environment approval |

### Branch protection on main

- Required checks: typecheck, lint, unit, integration (soak once it exists).
- One human approval; CODEOWNERS enforced for `intent/`, `.claude/`, `packages/db/migrations/`, `.github/workflows/`.
- No force pushes; linear history.

### Environments

| Environment | Deploys on | Gate |
|---|---|---|
| preview | each PR | none |
| staging | merge to main | CI green |
| production | tag v* | required reviewer: owner |

### Secrets (GitHub repository secrets; never in the repo)

`ANTHROPIC_API_KEY`, `FLY_API_TOKEN`, `STRIPE_TEST_SECRET`, `STRIPE_WEBHOOK_SECRET`, `TEMPORAL_ADDRESS`, `TEMPORAL_API_KEY` (if Temporal Cloud).

### Skill evals in CI

A fixture intent that references attendee emails and card payments is run through /spec on each change to `.claude/skills/policy-*`; the job fails if the resulting spec does not flag the known GDPR and PCI concerns. This protects the policy skills from regressing.

## 9. Public-repo hygiene

The `.claude/` directory and `intent/` folders are part of the portfolio; write them to be read.

- Apache-2.0 LICENSE, a SECURITY.md with a disclosure contact, a short README that explains the SDLC and links to the first intents.
- Fixtures and seed data use invented venues, events and people only; a lint rule or qa instruction rejects anything that looks like a real email or phone number.
- `.env.example` is committed; `.env*` is gitignored and denied to Claude in settings.json.
- Secret scanning and push protection enabled on the repository; Dependabot or Renovate on.
- Stripe test keys only, rotated if ever committed by mistake.
- No employer names, client names or internal system names anywhere in the repo or its history.

## 10. The SDLC loop in this repo

Every change produces a chain of version-controlled artifacts under `intent/<slug>/`; the commit history of that folder is the audit trail. One Claude Code session per stage; `/clear` between them.

1. **Intent** — originator (any role) runs /intent; Claude interviews and writes intent.md. Gate: owner approves by merging the PR. Metric: hours from first conversation to merged intent; share of intents accepted into Design.
2. **Design** — spec-on-intent.yml runs /spec; policy skills apply; concerns flagged. Gate: owner merges spec.md; a tech-lead co-approval for anything touching reservations, payments or migrations. Metric: time intent → spec; spec commits dated after the first plan commit (rework).
3. **Plan** — engineer runs /plan in plan mode; reviews and edits plan.md. Gate: human approval of the plan before any code.
4. **Implement** — fresh session, /implement; dev → qa → reviewer loop; hooks block protected paths and dangerous commands; the Stop hook refuses to finish on a red gate. Metric: QA rounds per step; gate failures per session.
5. **Ship** — /ship; PR links the chain; CI green plus one human review; Claude review comments only. Deploy preview → staging → prod with a human gate on prod. Metric: PR cycle time; reverts.
6. **Maintain** — alerts (oversells, hold-expiry lag, webhook failures) produce an incident record and, when the fix is non-trivial, a new intent.md with the alert as originator. The loop closes. Metric: incidents per release; time from alert to merged intent.

Skip the ceremony when the diff fits in one sentence; a typo fix does not need an intent.

## 11. First intents and the first prompt

Do not scaffold the monorepo by hand. Once sections 5–7 exist in an otherwise empty repo, the monorepo skeleton is the first intent, so the SDLC is exercised on something trivial before it meets the reservation engine.

### Bootstrap order

- [ ] Create the repo (public, Apache-2.0), enable secret scanning and push protection
- [ ] Write CLAUDE.md, settings.json, the three hooks, CODEOWNERS by hand; commit
- [ ] Write the five workflow skills and the three agents; commit
- [ ] Install skill-creator and frontend-design from the official marketplace
- [ ] Author policy-pci and policy-gdpr with skill-creator; commit
- [ ] Add GitHub secrets; set up branch protection and the three environments
- [ ] Run the first intent below

### First prompt to run in Claude Code

```
/intent monorepo skeleton: pnpm + turborepo workspace with apps web, admin,
scanner, api, worker and packages domain, db, contracts, config; the five
pnpm commands in CLAUDE.md working against an empty domain; Temporal dev
server wired to worker; Testcontainers smoke test for Postgres; ci.yml green
on an empty PR; deploy.yml building images but deploying nothing yet
```

Then: approve the intent, run /spec (the policy skills should stay quiet on a skeleton; if policy-gdpr fires, its description is too broad), /clear, /plan in plan mode, /clear, /implement, /ship. Expect rough edges in hooks and skills on this pass and fix them here, where mistakes are cheap.

### Intents in order after the skeleton

| # | Intent | Why this order |
|---|---|---|
| 2 | Venues, events and seat maps, read-only admin | First data model, first UI, exercises policy-accessibility |
| 3 | Holds with Temporal timers (create, expire, release) | First workflow; introduces the outbox |
| 4 | GA sales with Stripe test mode and confirmation email | First payment flow; policy-pci and policy-gdpr fire for real |
| 5 | Reserved-seat reservation engine | The hard one: race safety, property tests, the soak gate goes live |
| 6 | Waitlists and price tiers | Builds on 5 |
| 7 | Refunds and exchanges | Compensating transactions; policy-uk-refunds |
| 8 | Finance reconciliation and settlement export | First scheduled Temporal workflow at scale |
| 9 | Scanner PWA with offline sync | Second client, local-first store |
| 10 | Multi-tenant hardening and GDPR tooling (export, erasure) | Closes the compliance loop |
