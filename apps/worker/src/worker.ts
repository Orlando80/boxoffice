import { fileURLToPath } from "node:url";
import { Worker, type NativeConnection } from "@temporalio/worker";

export const TASK_QUEUE = "boxoffice";

// Shared by the process entrypoint and in-process integration tests.
export function createWorker(
  connection: NativeConnection,
  opts: { namespace: string; taskQueue?: string; activities?: object },
): Promise<Worker> {
  return Worker.create({
    connection,
    namespace: opts.namespace,
    taskQueue: opts.taskQueue ?? TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    ...(opts.activities === undefined ? {} : { activities: opts.activities }),
  });
}
