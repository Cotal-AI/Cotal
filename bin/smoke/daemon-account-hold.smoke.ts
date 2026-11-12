/** Real account HTTP and constructors, synthetic stopped Manager surface. Not daemon acceptance. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { saveIdpSession, signedInMachineAccounts } from "@cotal-ai/auth";
import { createAccountComputer } from "../daemon/account.js";
import { createAccountReconciler } from "../daemon/account-reconcile.js";
import { createServiceConnections } from "../daemon/service.js";
import type { HostedManager } from "../daemon/protocol.js";

const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "dach-")));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_HOME = root;
process.env.HOME = root;
process.env.XDG_CONFIG_HOME = join(root, "config");
let mode: 200 | 304 = 200;
let sub = "owner";
let gets = 0;
let conditional: string | undefined;
const fixture = createServer((req, res) => {
  assert.equal(req.headers.authorization, "Bearer fixture-session");
  const machine = req.url?.match(/^\/api\/cli\/machines\/([0-9a-f-]+)(\/spaces)?$/);
  res.setHeader("content-type", "application/json");
  if (!machine) { res.writeHead(404).end("{}"); return; }
  if (req.method === "PUT") {
    req.resume();
    res.end(JSON.stringify({ v: 1, machine: { id: machine[1], lastSeenAt: new Date().toISOString() } }));
    return;
  }
  gets++; conditional = req.headers["if-none-match"] as string | undefined;
  if (mode === 304) { res.writeHead(304).end(); return; }
  res.setHeader("etag", '"hold"');
  res.end(JSON.stringify({ v: 1, machineId: machine[1], revision: 2, bindingRevisions: {}, account: { idpUrl, issuer, sub }, spaces: [] }));
});
await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
const issuer = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
const idpUrl = `${issuer}/api/auth`;
saveIdpSession(root, idpUrl, { token: "fixture-session", sub, expiresAt: Date.now() / 1000 + 3600 });
const owner = signedInMachineAccounts(root)[0]!;
assert.ok(owner);
mkdirSync(join(root, "daemon"), { recursive: true, mode: 0o700 });
const savedFile = join(root, "daemon", "account-spaces.json");
const saved = JSON.stringify({ v: 1, spaces: { removed: { owner: owner.ownerKey, id: "removed-id", revision: 1, removedAt: 1 } } });
writeFileSync(savedFile, saved, { mode: 0o600 });
let managerEffects = 0;
const stopped = (space: string): HostedManager => ({ space, state: "stopped", restarts: 0 });
const services = createServiceConnections(root);
const reconciler = createAccountReconciler(root, services, {
  status: stopped, refresh: async space => stopped(space),
  start: async space => { managerEffects++; return stopped(space); },
  disconnect: async () => { managerEffects++; },
});
const account = createAccountComputer(root, "component", reconciler);
try {
  let finish!: () => void;
  const blocker = new Promise<void>(resolve => { finish = resolve; });
  const active = reconciler.serial(() => blocker);
  const a = reconciler.holdMutations("a");
  const b = reconciler.holdMutations("b");
  assert.equal(reconciler.holdMutations("a"), a);
  let drained = false;
  void a.drained.then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false, "captured queue work must finish before drain");
  finish(); await active; await a.drained;
  await account.start();
  assert.ok(gets > 0);
  assert.equal(readFileSync(savedFile, "utf8"), saved, "held 200 cannot change retained desired state");
  assert.equal(managerEffects, 0);
  assert.equal(reconciler.view().some(row => row.desired), false);
  a.release(); a.release();
  assert.equal(reconciler.isHeld(), true, "second owner keeps hold");
  const before = gets;
  mode = 304;
  await account.start();
  assert.ok(gets > before, "real HTTP forced 304 is consumed while held");
  assert.equal(conditional, undefined, "deferred 200 invalidates etag");
  assert.equal(readFileSync(savedFile, "utf8"), saved);
  b.release();
  const reacquired = reconciler.holdMutations("a");
  a.release();
  assert.equal(reconciler.isHeld(), true, "stale release cannot release new hold");
  reacquired.release();
  await account.start();
  assert.deepEqual(JSON.parse(readFileSync(savedFile, "utf8")).spaces, {}, "held 200 freshness survives 304: fresh removal is applied");
  assert.equal(managerEffects, 0);
  console.log("PASS held 200/304 freshness, owner holds and queue drain (synthetic queued callback)");

  const replacementHold = reconciler.holdMutations("replacement");
  mode = 200;
  await account.start();
  sub = "replacement";
  saveIdpSession(root, idpUrl, { token: "fixture-session", sub, expiresAt: Date.now() / 1000 + 3600 });
  account.signedIn();
  await account.start();
  replacementHold.release();
  await account.start();
  assert.equal(account.status().sub, "replacement");
  assert.ok(account.status().accounts?.every(row => row.sub === "replacement"));
  assert.equal(managerEffects, 0);
  assert.deepEqual(JSON.parse(readFileSync(savedFile, "utf8")).spaces, {});
  console.log("PASS account replacement discards old context while held, no stale replay");
} finally {
  await account.close();
  await services.close();
  fixture.closeAllConnections();
  await new Promise<void>(resolve => fixture.close(() => resolve()));
}
console.log(`ACCOUNT HOLD COMPONENT OK (synthetic integration, not full daemon acceptance); retained ${root}`);
