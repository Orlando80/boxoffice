---
name: ship
description: Commit and open a PR for an implemented plan
disable-model-invocation: true
---
Confirm the gate passes. Commit in conventional-commit units. Open a PR with
`gh pr create` whose body links intent.md, spec.md and plan.md and pastes the
spec's acceptance criteria as a checklist. Never push with --force.
