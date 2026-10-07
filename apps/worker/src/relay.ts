import { claimDue, purgeEndedHolds, purgePublished, type Db, type OutboxRow } from "@boxoffice/db";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowNotFoundError,
  type Client,
} from "@temporalio/client";

export interface RelayOptions {
  db: Db;
  client: Client;
  taskQueue: string;
  intervalMs?: number;
  batch?: number;
  housekeepingMs?: number;
  /** Fails a delivery that has not answered in this long (unreachable Temporal). Default 5000. */
  deliverTimeoutMs?: number;
  log?: (line: string) => void;
  /** Database hostname (never the URL) included in tick-failure logs. */
  dbHost?: string;
}

export interface Relay {
  stop(): Promise<void>;
  /** Runs one claim-and-deliver pass (exposed for tests). */
  tick(): Promise<{ claimed: number; published: number; failed: number }>;
}

interface HoldPayload {
  holdId: string;
  venueId: string;
}

export function startRelay(opts: RelayOptions): Relay {
  const { db, client, taskQueue } = opts;
  const intervalMs = opts.intervalMs ?? 500;
  const batch = opts.batch ?? 100;
  const housekeepingMs = opts.housekeepingMs ?? 60_000;
  const deliverTimeoutMs = opts.deliverTimeoutMs ?? 5000;
  const log = opts.log ?? ((l: string) => console.error(l));

  // Cancels the underlying gRPC call (and its retries) when the signal aborts.
  const bounded = <T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> =>
    typeof client.workflow.withAbortSignal === "function"
      ? client.workflow.withAbortSignal(signal, fn)
      : fn();

  const deliver = async (row: OutboxRow, signal: AbortSignal): Promise<void> => {
    const { holdId, venueId } = row.payload as HoldPayload;
    if (row.type === "hold.created") {
      try {
        await bounded(signal, () =>
          client.workflow.start("holdWorkflow", {
            taskQueue,
            workflowId: `hold-${holdId}`,
            args: [holdId, venueId],
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
          }),
        );
      } catch (e) {
        if (!(e instanceof WorkflowExecutionAlreadyStartedError)) throw e;
      }
    } else if (row.type === "hold.released") {
      try {
        await bounded(signal, () => client.workflow.getHandle(`hold-${holdId}`).signal("released"));
      } catch (e) {
        if (!(e instanceof WorkflowNotFoundError)) throw e;
      }
    }
    // hold.extended / hold.expired: nothing to deliver; the workflow re-reads the DB.
  };

  const handle = async (row: OutboxRow): Promise<void> => {
    const ctrl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = (): Error => {
      const e = new Error("delivery_timeout");
      e.name = "delivery_timeout";
      return e;
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(timedOut());
      }, deliverTimeoutMs);
    });
    const work = deliver(row, ctrl.signal);
    work.catch(() => undefined); // an aborted call may reject after the race is settled
    try {
      await Promise.race([work, timeout]);
    } catch (e) {
      throw ctrl.signal.aborted ? timedOut() : e;
    } finally {
      clearTimeout(timer);
    }
  };

  let running = false;
  const tick = async (): Promise<{ claimed: number; published: number; failed: number }> => {
    return claimDue(db, batch, handle);
  };

  const safe = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch {
      // Never log the error: it may echo connection strings. Name the stage only.
      const where = opts.dbHost !== undefined ? ` (db host ${opts.dbHost})` : "";
      log(`relay ${label} failed${where}; will retry`);
    }
  };

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let lastHousekeeping = Date.now();

  const loop = async (): Promise<void> => {
    try {
      await safe("tick", tick);
      if (Date.now() - lastHousekeeping >= housekeepingMs) {
        lastHousekeeping = Date.now();
        await safe("housekeeping", async () => {
          await purgePublished(db, 7);
          await purgeEndedHolds(db, 7);
        });
      }
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => {
    if (running || stopped) return; // skipped ticks never replace the running one
    running = true;
    inFlight = loop();
  }, intervalMs);

  return {
    tick,
    async stop() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
