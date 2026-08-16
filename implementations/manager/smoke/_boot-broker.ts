/**
 * Shared smoke helper: boot a throwaway JWT-auth nats-server on an OS-assigned free port
 * (see `_free-port.ts`; random ranges intermittently land on Windows reserved port blocks).
 *
 * `isReachable` returns true even against a FOREIGN broker squatting the port, so a naive
 * "wait until reachable" boot can silently attach to someone else's broker — whose trust chain
 * then rejects our creds with a confusing `Authorization Violation` deep in the test. Our
 * nats-server fails fast (EADDRINUSE exits within ~100ms) when the port is taken, so we verify
 * OUR child survived the bind before trusting reachability, and fail loud otherwise.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverConfig, isReachable, type SpaceAuth } from "@cotal-ai/core";
import { pickFreePort } from "./_free-port.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Broker {
  /** `nats://127.0.0.1:<port>` of the booted broker. */
  servers: string;
  /** `http://127.0.0.1:<port>` of the monitoring endpoint — present iff booted with `monitor`. */
  monitorUrl?: string;
  /** Stop the broker and clean up its store dir. */
  stop: () => Promise<void>;
}

/** Boot a JWT-auth nats-server for `auth` on an OS-assigned free loopback port.
 *  `monitor: true` also opens the loopback HTTP monitoring endpoint (`/connz` etc.), for smokes
 *  that assert broker-side truth about connections rather than trusting the client's own account. */
export async function bootBroker(auth: SpaceAuth, opts?: { monitor?: boolean }): Promise<Broker> {
  const port = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const monitorPort = opts?.monitor ? await pickFreePort() : undefined;
  const dir = mkdtempSync(join(tmpdir(), "cotal-smoke-broker-"));
  const conf = serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") })
    + (monitorPort !== undefined ? `http: 127.0.0.1:${monitorPort}\n` : "");
  writeFileSync(join(dir, "server.conf"), conf);
  const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 25; i++) {
    if (srv.exitCode !== null) break; // died (bind failure / bad config)
    if (await isReachable(servers)) { up = true; break; }
    await wait(200);
  }
  if (!up || srv.exitCode !== null) {
    srv.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`bootBroker: nats-server did not come up on ${port}`);
  }
  return {
    servers,
    ...(monitorPort !== undefined ? { monitorUrl: `http://127.0.0.1:${monitorPort}` } : {}),
    stop: async () => {
      srv.kill("SIGTERM");
      await wait(200);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
