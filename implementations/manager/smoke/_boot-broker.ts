/**
 * Shared smoke helper: boot a throwaway JWT-auth nats-server on a FREE port, robust to concurrent
 * smokes / leftover brokers that happen to pick the same random port.
 *
 * `isReachable` returns true even against a FOREIGN broker squatting the port, so a naive
 * "pick a random port, wait until reachable" boot can silently attach to someone else's broker — whose
 * trust chain then rejects our creds with a confusing `Authorization Violation` deep in the test. We
 * guard against that: our nats-server fails fast (EADDRINUSE exits within ~100ms) when the port is
 * taken, so we verify OUR child survived the bind before trusting reachability, and retry a fresh port
 * on collision. This makes the broker-backed smokes safe to run in parallel.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverConfig, isReachable, type SpaceAuth } from "@cotal-ai/core";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Broker {
  /** `nats://127.0.0.1:<port>` of the booted broker. */
  servers: string;
  /** Stop the broker and clean up its store dir. */
  stop: () => Promise<void>;
}

/** Boot a JWT-auth nats-server for `auth` on a free loopback port (retrying on bind collision). */
export async function bootBroker(auth: SpaceAuth): Promise<Broker> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    const servers = `nats://127.0.0.1:${port}`;
    const dir = mkdtempSync(join(tmpdir(), "cotal-smoke-broker-"));
    writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port, storeDir: join(dir, "js") }));
    const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
    // Give it a beat to bind or fail fast. If OUR process exited, the port was taken (or config bad) —
    // retry a fresh port rather than attach to whatever is squatting this one.
    await wait(400);
    if (srv.exitCode === null) {
      let up = false;
      for (let i = 0; i < 25; i++) {
        if (srv.exitCode !== null) break; // died late
        if (await isReachable(servers)) { up = true; break; }
        await wait(200);
      }
      if (up && srv.exitCode === null) {
        return {
          servers,
          stop: async () => {
            srv.kill("SIGTERM");
            await wait(200);
            rmSync(dir, { recursive: true, force: true });
          },
        };
      }
    }
    srv.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
  throw new Error("bootBroker: could not bind a free nats-server port after 8 attempts");
}
