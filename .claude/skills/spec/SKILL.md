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
