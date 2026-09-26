/** Throwaway repro probe: does the artifact store's max_bytes reservation exhaust max_file_store? */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { isReachable, setupSpaceStreams, openServerConfig } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-repro-"));
const CAP = 9 * 1024 * 1024 * 1024; // 9 GiB: two 4 GiB artifact stores fit, the third cannot
const conf = join(sd, "nats.conf");
writeFileSync(conf, openServerConfig({ port: PORT, host: "127.0.0.1", storeDir: join(sd, "js"), maxFileStore: CAP, transport: { kind: "plaintext" } }));
const broker = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
const servers = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { up = await isReachable(servers); if (!up) await wait(100); }
  if (!up) throw new Error("broker never came up");

  const nc = await connect({ servers });
  const jsm = await jetstreamManager(nc);
  let provisioned = 0;
  let refusal = "";
  for (let i = 0; i < 6; i++) {
    try { await setupSpaceStreams({ servers, space: `repro${i}` }); provisioned++; }
    catch (e) { const a = e as Record<string, unknown>; refusal = `${(e as Error).message} code=${String(a.code)} apiCode=${String(a.jsApiErrorCode ?? a.api_error ?? a.err_code)} keys=${Object.keys(a).join(",")}`; break; }
  }
  const info = await jsm.getAccountInfo();
  console.log("account info:", JSON.stringify(info));
  // Real usage vs reserved.
  let realBytes = 0, reserved = 0;
  for await (const si of jsm.streams.list()) { realBytes += si.state.bytes; if (si.config.max_bytes > 0) { reserved += si.config.max_bytes; console.log(`  reserving: ${si.config.name} = ${si.config.max_bytes}`); } }
  console.log(`max_file_store: ${CAP} (${(CAP / 2 ** 30).toFixed(2)} GiB)`);
  console.log(`spaces provisioned: ${provisioned}`);
  console.log(`refusal: ${refusal}`);
  console.log(`reserved by max_bytes: ${reserved} (${(reserved / 2 ** 30).toFixed(2)} GiB)`);
  console.log(`real bytes stored:    ${realBytes}`);
  await nc.close();
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
}
