/** Live daemon + desktop bridge smoke for structured space collisions, per-space resolution, and endorsed account migration. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { peerCredentials } from "@cotal-ai/seat";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { homeCotalDir, readMesh, recordMesh, spaceSegment } from "@cotal-ai/workspace";
import { importAccountComputerSpace } from "@cotal-ai/cli";
import { deleteIdpSession, loadIdpSession, saveIdpSession } from "@cotal-ai/auth";
import { daemonPaths } from "../daemon/endpoint.js";
import { runDesktopBridge } from "../daemon/desktop.js";
import { serveDaemon, type RunningDaemon } from "../daemon/server.js";

if (process.platform !== "linux") skipSuite("daemon-space-conflicts: live Linux daemon IPC only");

const root = mkdtempSync(join(tmpdir(), "cotal-space-conflicts-"));
chmodSync(root, 0o700);
const runtime = mkdtempSync("/tmp/cotal-sc-rt-");
const savedEnv = Object.entries(process.env);
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
for (const dir of ["home", "config", "data", "cache"]) mkdirSync(join(root, dir), { mode: 0o700 });
Object.assign(process.env, {
  HOME: join(root, "home"),
  COTAL_HOME: join(root, "home", ".cotal"),
  XDG_RUNTIME_DIR: runtime,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  DO_NOT_TRACK: "1",
});
mkdirSync(process.env.COTAL_HOME!, { recursive: true, mode: 0o700 });

const paths = daemonPaths();
const version = "0.183.1";
const oldOrigin = "https://old-cloud.example";
const newOrigin = "https://new-cloud.example";
const oldIdp = `${oldOrigin}/api/auth`;
const newIdp = `${newOrigin}/api/auth`;
const sub = "owner-sub-9926";
const audience = "cotal-cli";
const ownerKey = (origin: string) => createHash("sha256").update(`${origin}\0${sub}`).digest("hex");
const expiry = () => Math.floor(Date.now() / 1000) + 3600;

const bundle = (space: string, idpUrl: string) => ({
  space,
  server: "nats://127.0.0.1:4222",
  tlsRequired: false,
  sentinelCreds: `sentinel-${space}-${new URL(idpUrl).hostname}`,
  userAuth: {
    provider: "cotal" as const,
    idp: { url: idpUrl, issuer: oldOrigin, audience },
    endpoints: { url: `${new URL(idpUrl).origin}/exchange` },
  },
});

const catalogRow = (slug: string, label: string, kind: string, idpUrl: string) => ({
  id: `sp_${slug}`,
  slug,
  name: label,
  kind,
  role: "owner",
  registration: bundle(slug, idpUrl),
});

let newSpaces = [
  catalogRow("personal-home", "Personal", "personal", newIdp),
  catalogRow("cotal-team", "Cotal team", "team", newIdp),
  catalogRow("new-only", "New only", "team", newIdp),
];

const realFetch = globalThis.fetch;
let migrationPrompts = 0;
let machinePolls = new Map<string, number>();
let machineEnabled = false;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const json = (value: unknown, headers?: Record<string, string>) =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
  const machine = /^\/api\/cli\/machines\/([a-f0-9-]+)(\/spaces)?$/.exec(new URL(url).pathname);
  if (machine && [oldOrigin, newOrigin].includes(new URL(url).origin)) {
    if (!machineEnabled) return new Response(null, { status: 404 });
    const origin = new URL(url).origin, machineId = machine[1];
    if (init?.method === "PUT") return json({ v: 1, machine: { id: machineId, lastSeenAt: new Date().toISOString() } });
    machinePolls.set(origin, (machinePolls.get(origin) ?? 0) + 1);
    const idpUrl = `${origin}/api/auth`;
    const spaces = [catalogRow("personal-home", "Personal", "personal", idpUrl), catalogRow("cotal-team", "Cotal team", "team", idpUrl)];
    return json({ v: 1, machineId, revision: 1, account: { idpUrl, issuer: oldOrigin, sub }, spaces,
      bindingRevisions: Object.fromEntries(spaces.map(row => [row.id, 1])) });
  }
  if (url === `${oldOrigin}/.well-known/cotal-mesh`) {
    assert.equal(init?.headers, undefined, "public endorsement check carries no credentials");
    return json({ ...bundle("personal-home", oldIdp), nativeMigration: { version: 1, origin: newOrigin } });
  }
  if (url === `${newOrigin}/.well-known/cotal-mesh`) {
    return json(bundle("personal-home", newIdp));
  }
  if (url === `${oldIdp}/token`) {
    const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    return json({ token: `${part({ alg: "none" })}.${part({ iss: oldOrigin, sub, aud: audience, exp: expiry() })}.fixture` }, {
      link: `<${oldOrigin}/catalog>; rel="https://cotal.ai/relations/space-catalog"`,
    });
  }
  if (url === `${oldOrigin}/catalog`) {
    return json({
      v: 1,
      account: { idpUrl: oldIdp, issuer: oldOrigin, sub },
      spaces: [
        catalogRow("personal-home", "Personal", "personal", oldIdp),
        catalogRow("cotal-team", "Cotal team", "team", oldIdp),
      ],
    });
  }
  if (url === `${newIdp}/device/code`) {
    return json({
      device_code: "dev-9926",
      user_code: "MOVE-9926",
      verification_uri: `${newOrigin}/approve`,
      verification_uri_complete: `${newOrigin}/approve?user_code=MOVE-9926`,
      expires_in: 600,
      interval: 1,
    });
  }
  if (url === `${newIdp}/device/token`) {
    return json({ access_token: "migrated-fresh-session", expires_in: 3600 });
  }
  if (url === `${newIdp}/token`) {
    const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    return json({ token: `${part({ alg: "none" })}.${part({ iss: oldOrigin, sub, aud: audience, exp: expiry() })}.fixture` }, {
      link: `<${newOrigin}/catalog>; rel="https://cotal.ai/relations/space-catalog"`,
    });
  }
  if (url === `${newOrigin}/catalog`) {
    return json({
      v: 1,
      account: { idpUrl: newIdp, issuer: oldOrigin, sub },
      spaces: newSpaces,
    });
  }
  throw new Error(`unexpected fetch in daemon-space-conflicts smoke: ${url}`);
};

async function bridge(req: Record<string, unknown>): Promise<Record<string, any>[]> {
  const out = new PassThrough();
  const chunks: string[] = [];
  out.setEncoding("utf8");
  out.on("data", (c: string) => chunks.push(c));
  await runDesktopBridge({
    version,
    resolveTarget: () => ({ paths }),
    peerUid: (sock) => peerCredentials(sock).uid,
    input: Readable.from([`${JSON.stringify(req)}\n`]),
    output: out,
  });
  return chunks.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function existingHosting(space: string): () => void {
  const dir = join(homeCotalDir(), "daemon", spaceSegment(space));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = ["register-request.json", "manager-host.json"].map(name => join(dir, name));
  for (const file of files) writeFileSync(file, JSON.stringify({ v: 1, space }), { mode: 0o600 });
  const bytes = files.map(file => readFileSync(file, "utf8"));
  const registration = readMesh(space);
  return () => {
    assert.deepEqual(files.map(file => readFileSync(file, "utf8")), bytes, "service and Manager records survive refusal");
    assert.deepEqual(readMesh(space), registration, "registration survives refusal");
    for (const file of files) rmSync(file);
  };
}

let daemon: RunningDaemon | undefined;
try {
  // Seed retained login + catalog spaces at oldIdp, a manual space, and a new login at newIdp.
  const oldAccount = { idpUrl: oldIdp, issuer: oldOrigin, sub, ownerKey: ownerKey(oldOrigin) };
  saveIdpSession(homeCotalDir(), oldIdp, { token: "old-session-token", sub, expiresAt: expiry() });
  saveIdpSession(homeCotalDir(), newIdp, { token: "new-session-token", sub, expiresAt: expiry() });
  writeFileSync(join(homeCotalDir(), "space-catalogs.json"), JSON.stringify({
    ver: 1,
    accounts: {
      [oldAccount.ownerKey]: { ...oldAccount, advertised: true, catalogUrl: `${oldOrigin}/catalog`, applied: true },
    },
  }), { mode: 0o600 });
  importAccountComputerSpace(oldAccount, catalogRow("personal-home", "Personal", "personal", oldIdp));
  importAccountComputerSpace(oldAccount, catalogRow("cotal-team", "Cotal team", "team", oldIdp));
  recordMesh({
    space: "new-only",
    server: "nats://127.0.0.1:4222",
    root,
    mode: "user",
    origin: "manual",
    userAuth: { provider: "cotal", idp: { url: "https://manual.example/api/auth", issuer: "https://manual.example", audience }, endpoints: { url: "https://manual.example/exchange" }, remote: true },
    ts: new Date().toISOString(),
  });

  daemon = await serveDaemon({ paths, version, peerUid: (sock) => peerCredentials(sock).uid });

  // 1. Refresh spaces: returns structured collisionDetails and endorsed migration candidate.
  const refreshedFrames = await bridge({ op: "spaces", refresh: true });
  const refreshed = refreshedFrames.at(-1)!;
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.result.refresh, "partial");
  assert.equal(refreshed.result.collisions, 3);
  assert.equal(refreshed.result.collisionDetails.length, 3);
  assert.deepEqual(refreshed.result.migration, {
    fromIdp: oldIdp,
    toIdp: newIdp,
    spaces: ["cotal-team", "personal-home"],
  });

  // 2. Per-space replacement of a catalog-owned entry is refused cleanly with CONFLICT (must move or sign out).
  const checkCatalogHosting = existingHosting("personal-home");
  const catalogReplaceRefused = (await bridge({ op: "space-conflict-resolve", space: "personal-home", idp: newIdp })).at(-1)!;
  assert.equal(catalogReplaceRefused.ok, false);
  assert.equal(catalogReplaceRefused.error.code, "CONFLICT");
  assert.match(catalogReplaceRefused.error.message, /Move or sign out/);
  checkCatalogHosting();

  deleteIdpSession(homeCotalDir(), oldIdp);
  const signedOut = (await bridge({ op: "spaces", refresh: true })).at(-1)!;
  assert.equal(signedOut.result.migration, undefined);
  assert.equal(signedOut.result.collisionDetails.find((row: { space: string }) => row.space === "personal-home").existingSignedIn, false);
  const absent = await bridge({ op: "login", idp: newIdp, migrateFrom: oldIdp });
  assert.equal(absent.some(frame => frame.event === "login-prompt"), false);
  assert.equal(absent.at(-1)!.result.reason, "local-state-error");
  assert.match(absent.at(-1)!.result.message, /not signed in/);
  saveIdpSession(homeCotalDir(), oldIdp, { token: "old-session-token", sub, expiresAt: expiry() });

  // 3. Per-space replacement of a manual registration succeeds and switches it to newIdp's catalog.
  const manualResolved = (await bridge({ op: "space-conflict-resolve", space: "new-only", idp: newIdp })).at(-1)!;
  assert.equal(manualResolved.ok, true);
  assert.equal(readMesh("new-only")?.origin, "catalog");
  assert.equal(readMesh("new-only")?.userAuth?.idp.url, newIdp);
  assert.equal(manualResolved.result.collisions, 2);

  // 4. One-button endorsed account move via login + migrateFrom updates both old catalog spaces to newIdp
  // EVEN when newIdp already owns a third space (`new-only`, mixed ownership: 2 old-owned + 1 new-owned).
  const existingNewOnly = readMesh("new-only")!;
  newSpaces = [
    catalogRow("personal-home", "Personal", "personal", newIdp),
    catalogRow("cotal-team", "Cotal team", "team", newIdp),
    catalogRow("new-only", "New only", "team", newIdp),
  ];
  const goodSnapshot = newSpaces;
  newSpaces = goodSnapshot.filter(row => row.slug !== "cotal-team");
  const mismatched = (await bridge({ op: "login", idp: newIdp, migrateFrom: oldIdp })).at(-1)!;
  assert.equal(mismatched.result.reason, "local-state-error");
  assert.match(mismatched.result.message, /do not match the spaces saved under the previous address/);
  assert.equal(readMesh("cotal-team")?.userAuth?.idp.url, oldIdp);
  assert.equal(loadIdpSession(homeCotalDir(), newIdp)?.token, "new-session-token");
  newSpaces = goodSnapshot;
  const moveFrames = await bridge({ op: "login", idp: newIdp, migrateFrom: oldIdp });
  migrationPrompts = moveFrames.filter((f) => f.event === "login-prompt").length;
  assert.equal(migrationPrompts, 1, "endorsed migration emits a fresh browser approval prompt");
  const moveResult = moveFrames.at(-1)!;
  assert.equal(moveResult.ok, true, JSON.stringify(moveFrames));
  assert.equal(moveResult.result.outcome, "signed-in", JSON.stringify(moveFrames));
  assert.equal(loadIdpSession(homeCotalDir(), newIdp)?.token, "migrated-fresh-session");
  assert.equal(readMesh("personal-home")?.userAuth?.idp.url, newIdp);
  assert.equal(readMesh("cotal-team")?.userAuth?.idp.url, newIdp);
  assert.deepEqual(readMesh("new-only"), existingNewOnly, "already new-owned space remains untouched during endorsed move");

  // 5. Immediately after migration (EVEN while old session is retained on disk, matching stock
  // `cotal login --migrate-from`), spaces refresh ignores the superseded old account and reports 0 collisions!
  const cleanRefresh = (await bridge({ op: "spaces", refresh: true })).at(-1)!;
  assert.equal(cleanRefresh.ok, true);
  assert.equal(cleanRefresh.result.refresh, "complete", JSON.stringify(cleanRefresh));
  assert.equal(cleanRefresh.result.collisions, 0);
  assert.equal(cleanRefresh.result.collisionDetails, undefined);
  assert.equal(cleanRefresh.result.migration, undefined);

  // 6. Running local stack blocks per-space replacement with plain-language LIFECYCLE_BLOCKED refusal.
  const localRoot = join(root, "running-project");
  mkdirSync(join(localRoot, ".cotal"), { recursive: true, mode: 0o700 });
  // Simulate a live local mesh owner pidfile for "running-local".
  const spaceDir = join(localRoot, ".cotal", "meshes", `space.${Buffer.from("running-local").toString("hex")}`);
  mkdirSync(spaceDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(localRoot, ".cotal", "nats.pid"), `${process.pid}\n`, { mode: 0o600 });
  writeFileSync(join(localRoot, ".cotal", "stack.json"), JSON.stringify({ v: 1, space: "running-local", pid: process.pid }), { mode: 0o600 });
  recordMesh({ space: "running-local", server: "nats://127.0.0.1:4222", root: localRoot, mode: "open", origin: "up", ts: new Date().toISOString() });
  newSpaces = [...newSpaces, catalogRow("running-local", "Running local", "team", newIdp)];

  const blockedRefresh = (await bridge({ op: "spaces", refresh: true })).at(-1)!;
  assert.equal(blockedRefresh.result.collisions, 1);
  assert.equal(blockedRefresh.result.collisionDetails[0].space, "running-local");
  assert.equal(blockedRefresh.result.collisionDetails[0].existingOrigin, "up");

  const checkRunningHosting = existingHosting("running-local");
  const blockedResolve = (await bridge({ op: "space-conflict-resolve", space: "running-local", idp: newIdp })).at(-1)!;
  assert.equal(blockedResolve.ok, false);
  assert.equal(blockedResolve.error.code, "LIFECYCLE_BLOCKED");
  assert.match(blockedResolve.error.message, /currently running on this computer/);
  assert.equal(readMesh("running-local")?.origin, "up", "running local registration was preserved");
  checkRunningHosting();

  // Model the durable boundary of an interruption: keep the actual committed registry and restore
  // the account-computer custody record as it was before the daemon could reconcile it.
  await daemon.close();
  daemon = undefined;
  const custodyFile = join(homeCotalDir(), "daemon", "account-spaces.json");
  const custody = Object.fromEntries(["personal-home", "cotal-team"].map(space => [space, { owner: oldAccount.ownerKey, id: `sp_${space}`, revision: 1 }]));
  writeFileSync(custodyFile, JSON.stringify({ v: 1, spaces: custody }), { mode: 0o600 });
  machineEnabled = true;
  daemon = await serveDaemon({ paths, version, peerUid: (sock) => peerCredentials(sock).uid });
  const deadline = Date.now() + 12_000;
  while ((machinePolls.get(oldOrigin) ?? 0) < 2 || (machinePolls.get(newOrigin) ?? 0) < 2) {
    assert.ok(Date.now() < deadline, "both account loops must poll again after startup");
    await delay(50);
  }
  const restarted = (await bridge({ op: "status" })).at(-1)!;
  for (const [space, prior] of Object.entries(custody)) {
    const migrated = JSON.parse(readFileSync(custodyFile, "utf8")).spaces[space];
    assert.deepEqual(migrated, { ...prior, owner: ownerKey(newOrigin) });
    const status = restarted.result.account.spaces.find((row: { space: string }) => row.space === space);
    assert.equal(status.desired, true);
    assert.doesNotMatch(status.lastRefusal ?? "", /connection is held by/);
    assert.equal(status.custodyRecovery, undefined);
  }
  console.log("PASS account poll restart: migrated custody adopted; retained legacy poll did not report a holder");

  console.log("PASS daemon-space-conflicts: structured collisions, per-space resolution, running-stack guard, and endorsed account move");
} finally {
  globalThis.fetch = realFetch;
  await daemon?.close();
  for (const key of Object.keys(process.env)) if (!savedEnv.some(([name]) => name === key)) delete process.env[key];
  for (const [key, value] of savedEnv) process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
  rmSync(runtime, { recursive: true, force: true });
}
