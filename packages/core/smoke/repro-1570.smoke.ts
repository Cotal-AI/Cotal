import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  createSpaceAuth, mintCreds, mintMembershipObserverCreds, newIdentity,
  serverConfig, startMembershipFeed,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, budgetMs: number, stepMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) { if (await cond()) return true; await wait(stepMs); }
  return await cond();
};

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `repro-1570-${Date.now()}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));

let releaseBroker = (): void => {};
let brokerLog = "";
const startBroker = (): ChildProcess => {
  releaseBroker();
  const p = spawn("nats-server", ["-D", "-c", join(dir, "server.conf")], { stdio: ["ignore", "pipe", "pipe"] });
  p.stdout?.on("data", (d: Buffer) => { brokerLog += d.toString(); });
  p.stderr?.on("data", (d: Buffer) => { brokerLog += d.toString(); });
  releaseBroker = teardownOnSignal(p, dir);
  return p;
};

let srv = startBroker();
const observerCreds = await mintMembershipObserverCreds(auth, newIdentity());
const accountId = auth.account.pub;

const expiringId = newIdentity();
let expiringReads = 0;
const expiringLog: string[] = [];

let feed: Awaited<ReturnType<typeof startMembershipFeed>> | undefined;

try {
  feed = await startMembershipFeed({
    servers: SERVERS, space, accountId, observerCreds, intervalMs: 60_000,
    log: (m) => { expiringLog.push(m); },
    rwCreds: async () => {
      expiringReads++;
      if (expiringReads === 1) return mintCreds(auth, expiringId, "membership-rw", { expiresInSeconds: 3 });
      throw new Error("fixture renewal source offline");
    },
  });

  // Wait for expiry to be detected
  await until(() => expiringLog.some((m) => /rw creds have expired/.test(m)), 12_000, 100);

  const expiryLogMark = expiringLog.find((m) => /rw creds have expired/.test(m)) ?? "";
  const claimedRetry = /retrying with backoff/.test(expiryLogMark);

  // Now measure whether conn B ever attempts to dial again over a 5s window
  const mark = brokerLog.length;
  await wait(5_000);
  const windowLog = brokerLog.slice(mark);

  // Any connection from conn B's nkey in this window:
  const redials = windowLog.split("\n").filter((l) => l.includes(`nkey:${expiringId.id}`));

  console.log(`[repro-1570] logged message: ${expiryLogMark}`);
  console.log(`[repro-1570] claimedRetry=${claimedRetry}, post-expiry redials in 5s window=${redials.length}`);

  // The defect is present if the feed claims "retrying with backoff" while conn B closes permanently (0 dials)
  const defectPresent = claimedRetry && redials.length === 0;
  if (defectPresent) {
    console.log("DEFECT PRESENT: conn B closed permanently on credential expiry while logging that it is retrying");
    process.exitCode = 1;
  } else {
    console.log("DEFECT NOT PRESENT");
  }
} finally {
  if (feed) {
    try { await feed.stop(); } catch { /* ignore */ }
  }
  releaseBroker();
  try { srv.kill(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
