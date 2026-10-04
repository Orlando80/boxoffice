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
