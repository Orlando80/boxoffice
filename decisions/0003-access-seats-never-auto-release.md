# Unsold access seats never auto-release

- **Status:** accepted
- **Date:** 2026-10-05
- **Owner:** repo owner (@Orlando80)
- **Applies to:** `.claude/skills/policy-accessibility` rule A11Y-10

## Question
What happens to unsold access seats as the event approaches?

## Options
1. Never auto-release; venue staff release manually, per event and per seat **(chosen)**
2. Auto-release to general sale at a venue-configured cut-off (e.g. 48 h)

## Why
Disabled customers often book late once access arrangements are confirmed; automatic release removes capacity exactly when it is needed.

## Consequences
No scheduled job releases access or companion seats. Staff releases are per seat and recorded in the audit log.
