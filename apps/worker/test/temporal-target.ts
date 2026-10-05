import net from "node:net";
import { GenericContainer, Wait } from "testcontainers";
import { TEMPORAL_DEV_IMAGE } from "../src/temporal-image.js";

export interface TemporalTarget {
  address: string;
  stop: () => Promise<void>;
  via: "dev-server" | "testcontainers";
}

function probe(address: string, timeoutMs: number): Promise<boolean> {
  const idx = address.lastIndexOf(":");
  const host = address.slice(0, idx) || "localhost";
  const port = Number(address.slice(idx + 1));
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export async function getTemporalTarget(): Promise<TemporalTarget> {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  if (await probe(address, 2000)) {
    console.log(`[temporal-target] using running dev server at ${address}`);
    return { address, stop: async () => {}, via: "dev-server" };
  }
  // Image tag comes from src/temporal-image.ts, shared with `pnpm temporal:dev`.
  const container = await new GenericContainer(TEMPORAL_DEV_IMAGE)
    .withCommand(["server", "start-dev", "--ip", "0.0.0.0"])
    .withExposedPorts(7233)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120_000)
    .start();
  const mapped = `${container.getHost()}:${container.getMappedPort(7233)}`;
  console.log(`[temporal-target] no dev server at ${address}; started Testcontainers ${TEMPORAL_DEV_IMAGE} at ${mapped}`);
  return { address: mapped, stop: async () => { await container.stop(); }, via: "testcontainers" };
}
