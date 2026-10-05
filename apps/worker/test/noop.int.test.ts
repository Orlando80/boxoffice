import { randomUUID } from "node:crypto";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorker } from "../src/worker.js";
import { noopWorkflow } from "../src/workflows.js";
import { getTemporalTarget, type TemporalTarget } from "./temporal-target.js";

describe("noopWorkflow against Temporal", () => {
  let target: TemporalTarget;
  let native: NativeConnection;
  let clientConn: Connection;

  beforeAll(async () => {
    target = await getTemporalTarget();
    native = await NativeConnection.connect({ address: target.address });
    clientConn = await Connection.connect({ address: target.address });
  });

  afterAll(async () => {
    await clientConn?.close();
    await native?.close();
    await target?.stop();
  });

  it("runs to completion and returns ok", async () => {
    const taskQueue = `test-${randomUUID()}`;
    const worker = await createWorker(native, { namespace: "default", taskQueue });
    const client = new Client({ connection: clientConn });
    const result = await worker.runUntil(
      client.workflow.execute(noopWorkflow, { taskQueue, workflowId: `noop-${randomUUID()}` }),
    );
    expect(result).toBe("ok");
  });
});
