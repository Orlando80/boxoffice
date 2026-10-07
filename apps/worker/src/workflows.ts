// Workflow bundle: import only from @temporalio/workflow (deterministic sandbox).
import { condition, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";

export async function noopWorkflow(): Promise<"ok"> {
  return "ok";
}

// Declared here (not imported) so this file stays free of non-workflow imports.
// activities.ts satisfies this interface. Return values are serialisable.
export interface HoldActivities {
  getHoldExpiry(
    venueId: string,
    holdId: string,
  ): Promise<{ status: string; expiresAt: string } | null>;
  expireHoldIfDue(
    venueId: string,
    holdId: string,
  ): Promise<{ ended: boolean; expiresAt: string | null }>;
}

const { getHoldExpiry, expireHoldIfDue } = proxyActivities<HoldActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "1 second", maximumInterval: "30 seconds", backoffCoefficient: 2 },
});

export const releasedSignal = defineSignal("released");

/** Sleeps until the hold's expiry, then ends it if still due. Stops on release or end. */
export async function holdWorkflow(holdId: string, venueId: string): Promise<void> {
  let released = false;
  setHandler(releasedSignal, () => {
    released = true;
  });

  let current = await getHoldExpiry(venueId, holdId);
  for (;;) {
    if (released || current === null || current.status !== "active") return;
    const wait = Math.max(1, Date.parse(current.expiresAt) - Date.now());
    await condition(() => released, wait);
    if (released) return;
    const result = await expireHoldIfDue(venueId, holdId);
    if (result.ended || result.expiresAt === null) return;
    current = { status: "active", expiresAt: result.expiresAt };
  }
}
