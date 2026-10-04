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
