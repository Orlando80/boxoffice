// Workflow bundle: import only from @temporalio/workflow (deterministic sandbox).
export async function noopWorkflow(): Promise<"ok"> {
  return "ok";
}
