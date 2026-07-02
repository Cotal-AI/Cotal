/**
 * sub.allow chat read-boundary smoke (SPEC v0.3 §9 / Appendix B). Proves the load-bearing claim of
 * the core-sub rebuild: an agent's `allowSubscribe` is minted as a native `sub.allow` over
 * cotal.<space>.chat.*.<channel> (wildcards passed through), and nats-server enforces it per
 * subscribe — so a manager-free `nc.subscribe` to an in-ACL channel succeeds and an out-of-ACL one is
 * refused. Also pins the wildcard semantics the panel flagged: `review.>` does NOT cover bare `review`.
 *
 * Run: pnpm smoke:sub-acl:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  chatSubject,
  spacePrefix,
} from "../src/index.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

/** Subscribe to `subject` with a scoped agent cred; resolve "denied" if a permission/authorization
 *  violation surfaces (async on the connection status channel or the sub callback in nats.js), else
 *  "allowed" if the subscription stays live through the grace window. */
async function trySubscribe(
  creds: string,
  id: string,
  subject: string,
  graceMs = 400,
): Promise<"allowed" | "denied"> {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    inboxPrefix: `_INBOX_${id}`, // request/reply must land inside the agent's sub.allow
    maxReconnectAttempts: 0,
  });
  let denied = false;
  void (async () => {
    for await (const s of nc.status()) {
      const blob = `${(s as { type?: string }).type ?? ""} ${(s as { data?: unknown }).data ?? ""}`;
      if (/permission|authorization/i.test(blob)) denied = true;
    }
  })().catch(() => {});
  const sub = nc.subscribe(subject, {
    callback: (err) => {
      if (err) denied = true;
    },
  });
  await nc.flush().catch(() => {
    denied = true;
  });
  await wait(graceMs);
  try {
    sub.unsubscribe();
  } catch {
    /* ignore */
  }
  await nc.drain().catch(() => {});
  return denied ? "denied" : "allowed";
}

const space = `sub-acl-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-subacl-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

const noop = {
  commitAcl: async () => {},
  provisionDmInbox: async () => {},
  provisionDlvInbox: async () => {},
  provisionTaskQueue: async () => {},
};

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) {
      up = true;
      break;
    }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });

  // Agent A: read ACL = the `review.>` subtree (wildcard). sub.allow ⇒ cotal.<space>.chat.*.review.>
  const a = newIdentity();
  const aCreds = await provisionAgent(noop, auth, a, {
    subscribe: ["review.alpha"],
    allowSubscribe: ["review.>"],
  });

  // ALLOWED — own inbox prefix.
  check(
    "A: subscribe own _INBOX is allowed",
    (await trySubscribe(aCreds, a.id, `_INBOX_${a.id}.reply`)) === "allowed",
  );
  // ALLOWED — a concrete channel under the wildcard ACL (the self-serve live join subject).
  check(
    "A: subscribe chat.*.review.alpha (in review.>) is allowed",
    (await trySubscribe(aCreds, a.id, chatSubject(space, "*", "review.alpha"))) === "allowed",
  );
  check(
    "A: subscribe chat.*.review.deep.nested (in review.>) is allowed",
    (await trySubscribe(aCreds, a.id, chatSubject(space, "*", "review.deep.nested"))) === "allowed",
  );
  // DENIED — out-of-ACL channels.
  check(
    "A: subscribe chat.*.secret (out of ACL) is DENIED",
    (await trySubscribe(aCreds, a.id, chatSubject(space, "*", "secret"))) === "denied",
  );
  check(
    "A: subscribe chat.*.general (out of ACL) is DENIED",
    (await trySubscribe(aCreds, a.id, chatSubject(space, "*", "general"))) === "denied",
  );
  // DENIED — bare `review` is NOT covered by `review.>` (one-or-more-tokens wildcard semantics).
  check(
    "A: subscribe chat.*.review (bare root, NOT in review.>) is DENIED",
    (await trySubscribe(aCreds, a.id, chatSubject(space, "*", "review"))) === "denied",
  );
  // DENIED — the space firehose escape hatch.
  check(
    "A: subscribe space wildcard cotal.<space>.> is DENIED",
    (await trySubscribe(aCreds, a.id, `${spacePrefix(space)}.>`)) === "denied",
  );

  // Agent B: read ACL = ["ops"] only — cross-agent isolation: B is bounded by ITS OWN ACL.
  const b = newIdentity();
  const bCreds = await provisionAgent(noop, auth, b, {
    subscribe: ["ops"],
    allowSubscribe: ["ops"],
  });
  check(
    "B: subscribe chat.*.ops (in its ACL) is allowed",
    (await trySubscribe(bCreds, b.id, chatSubject(space, "*", "ops"))) === "allowed",
  );
  check(
    "B: subscribe chat.*.review.alpha (A's channel, out of B's ACL) is DENIED",
    (await trySubscribe(bCreds, b.id, chatSubject(space, "*", "review.alpha"))) === "denied",
  );

  console.log(`\nSUB-ACL SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
