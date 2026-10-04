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
