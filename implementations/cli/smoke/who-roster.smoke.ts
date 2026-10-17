/**
 * `cotal who` and `cotal whoami` on the structured output contract, against a broker this suite owns.
 * Real agents register presence with harness, model and host metadata; the CLI child reads them with
 * its own one-shot credential. Covers the default, `--waiting` and `--all` filters, the rich and
 * plain reports, the managed column with no manager present and with a manager that does not answer
 * (a partial read, exit 4), a credential that may not read the roster, and `whoami` for a signer, an
 * open mesh and each user-auth grant state (the last through a stub provider, in process).
 *
 * Isolation: every CLI child gets a sandboxed HOME / XDG_CONFIG_HOME / TMPDIR / COTAL_HOME, and
 * inherited COTAL_* is stripped.
 *
 * Run: pnpm smoke:who-roster
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CotalEndpoint,
  createSpaceAuth,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  registry,
  seedChannelRegistry,
  serverConfig,
  setupSpaceStreams,
} from "@cotal-ai/core";
import { createSuite, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal, teardownPathOnSignal } from "@cotal-ai/smoke-kit";
import { authDir, recordMesh, saveSpaceAuth, setCurrent } from "@cotal-ai/workspace";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}
const { check, finish } = createSuite();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Row = { name: string; kind: string; status: string; activity: string | null; condition: { code: string } | null; harness: string | null; model: string | null; host: string | null; managed: boolean | null; attention: string | null };
type Envelope = {
  outcome: string;
  completeness: string;
  command: string;
  target: { space: string; scope?: string };
  result: { kind: string; view?: string; managers?: string; hidden?: number; items?: Row[]; identity?: { kind: string; principal: string | null; grant: string | null }; read?: unknown; post?: unknown; dms?: boolean | null; capabilities?: unknown } | null;
  warnings: { code: string; message: string }[];
  error?: { code: string; message: string };
};

const space = `whosmoke-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const storeDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(storeDir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(storeDir, "js") }));
const broker = spawn("nats-server", ["-c", join(storeDir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, storeDir);

const home = mkdtempSync(join(tmpdir(), "cotal-who-home-"));
const releaseHome = teardownPathOnSignal(home);
mkdirSync(join(home, ".cotal"), { recursive: true });
const xdg = join(home, "xdg");
mkdirSync(xdg);
const meshRoot = join(home, "mesh-root");
mkdirSync(join(meshRoot, ".cotal"), { recursive: true });
const openRoot = join(home, "open-root");
mkdirSync(join(openRoot, ".cotal"), { recursive: true });
const shell = join(home, "shell");
mkdirSync(join(shell, ".cotal"), { recursive: true });

const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (key.startsWith("COTAL_") || key === "FORCE_COLOR" || key === "NO_COLOR") delete cleanEnv[key];
const isolatedEnv: NodeJS.ProcessEnv = { ...cleanEnv, HOME: home, USERPROFILE: home, TMPDIR: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1" };

const run = (args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ status: number; stdout: string; stderr: string; envelope?: Envelope }> =>
  new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd: shell, env: { ...isolatedEnv, ...extra }, timeout: 120_000 }, (err, stdout, stderr) => {
      const lines = stdout.split("\n").filter(Boolean);
      const envelope = lines.length === 1 && lines[0]!.startsWith("{") ? (JSON.parse(lines[0]!) as Envelope) : undefined;
      resolve({ status: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout, stderr, envelope });
    });
  });
const shown = (r: { status: number; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 1200), stderr: r.stderr.slice(0, 600) });
const rowsOf = (r: { envelope?: Envelope }) => Object.fromEntries((r.envelope?.result?.items ?? []).map((row) => [row.name, row]));

const endpoints: CotalEndpoint[] = [];
let provisioner: CotalEndpoint | undefined;
try {
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    ready = await isReachable(servers);
    if (!ready) await wait(100);
  }
  check("control: the owned broker is ready", ready, servers);
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisionerCreds });
  await seedChannelRegistry({ servers, space, creds: provisionerCreds, file: { channels: { general: {} } } });
  saveSpaceAuth(authDir(meshRoot), auth);
  const priorHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = isolatedEnv.COTAL_HOME;
  try {
    recordMesh({ space, server: servers, root: meshRoot, mode: "auth", origin: "manual", ts: new Date().toISOString() });
    recordMesh({ space: "openmesh", server: `nats://127.0.0.1:${await pickFreePort()}`, root: openRoot, mode: "open", origin: "manual", ts: new Date().toISOString() });
    setCurrent(space);
  } finally {
    if (priorHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = priorHome;
  }
  provisioner = new CotalEndpoint({ space, servers, creds: provisionerCreds, card: { name: "who-provisioner", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false });
  await provisioner.start();

  /** One participant on the roster under its own provisioned credential. */
  const join_ = async (name: string, card: { role?: string; kind: "agent" | "endpoint"; meta?: Record<string, string> }) => {
    const identity = newIdentity();
    const lifecycleUid = mintLifecycleUid();
    const creds = await provisionAgent(provisioner!, auth, identity, { lifecycleUid, ...(card.role ? { role: card.role } : {}), subscribe: [], allowSubscribe: [] });
    const ep = new CotalEndpoint({ space, servers, creds, lifecycleUid, card: { name, id: identity.id, ...card }, channels: [], heartbeatMs: 500, ttlMs: 10_000 });
    ep.on("error", () => {});
    await ep.start();
    endpoints.push(ep);
    return ep;
  };
  const alice = await join_("alice", { role: "builder", kind: "agent", meta: { connector: "claude-code", model: "opus-test", host: "box-a" } });
  const bob = await join_("bob", { role: "reviewer", kind: "agent", meta: { connector: "jcode", model: "glm-test", host: "box-b" } });
  const carol = await join_("carol", { kind: "agent" });
  await join_("logger", { role: "logger", kind: "endpoint" });
  await alice.setStatus("working");
  await bob.setStatus("waiting");
  await bob.setActivity("reviewing the change");
  await carol.setCondition({ code: "auth", source: "harness", since: Date.now() });
  await wait(1_000);

  // ── the default roster ──────────────────────────────────────────────────────────────────────────
  const json = await run(["who", "--json"]);
  const env = json.envelope;
  const rows = rowsOf(json);
  check("who --json is one complete ok envelope", json.status === 0 && env?.outcome === "ok" && env.completeness === "complete" && env.command === "who", shown(json));
  check("its target names the selected space and the agents scope", env?.target.space === space && env.target.scope === "agents", env?.target);
  check("every agent is listed and the infrastructure endpoint is not", Object.keys(rows).sort().join() === "alice,bob,carol" && env?.result?.hidden === 1, Object.keys(rows));
  check("the CLI's own one-shot endpoint is not on the roster", !Object.keys(rows).some((n) => n === "who"), Object.keys(rows));
  check("harness, model and host come from the presence metadata", rows.alice?.harness === "claude-code" && rows.alice.model === "opus-test" && rows.alice.host === "box-a" && rows.carol?.harness === null, rows.alice);
  check("status, activity and condition are each row's own", rows.alice?.status === "working" && rows.bob?.status === "waiting" && rows.bob.activity === "reviewing the change" && rows.carol?.condition?.code === "auth", { alice: rows.alice, bob: rows.bob, carol: rows.carol });
  check("with no manager on the roster, no seat is managed and nothing is asked", env?.result?.managers === "none-present" && Object.values(rows).every((r) => r.managed === false), env?.result);
  check("--json writes nothing on stderr", json.stderr === "", json.stderr);

  const waiting = await run(["who", "--waiting", "--json"]);
  check("--waiting keeps the waiting row and the row with a condition", Object.keys(rowsOf(waiting)).sort().join() === "bob,carol" && waiting.envelope?.target.scope === "waiting", Object.keys(rowsOf(waiting)));
  const all = await run(["who", "--all", "--json"]);
  check("--all adds the infrastructure endpoint, with no managed answer", rowsOf(all).logger?.kind === "endpoint" && rowsOf(all).logger?.managed === null && all.envelope?.result?.hidden === 0, rowsOf(all).logger);

  const plain = await run(["who", "--plain"], { FORCE_COLOR: "1" });
  const rich = await run(["who"], { FORCE_COLOR: "1" });
  check("the plain report is a table with every state word and no ANSI", plain.status === 0 && !/\x1b\[/.test(plain.stdout) && /^NAME\s+STATUS\s+ATTENTION/m.test(plain.stdout) && /bob\/reviewer\s+waiting/.test(plain.stdout) && /idle \(auth for/.test(plain.stdout), shown(plain));
  check("the plain report says the hidden endpoint is listed by --all", /1 infrastructure endpoint is not listed; `cotal who --all` lists them/.test(plain.stdout), plain.stdout);
  const richText = rich.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  check(
    "the rich report is colored, marks each state and keeps every state word",
    rich.status === 0 && /\x1b\[/.test(rich.stdout) && /● working · progress unknown/.test(richText) && /◐ waiting/.test(richText) && /○ idle \(auth for/.test(richText),
    richText.slice(0, 800),
  );

  // ── a manager on the roster that does not answer: the managed column is unknown, the read partial ─
  await join_("manager", { role: "manager", kind: "endpoint" });
  await wait(800);
  const unread = await run(["who", "--json"]);
  check("a manager that does not answer makes who partial with exit 4", unread.status === 4 && unread.envelope?.outcome === "partial" && unread.envelope.completeness === "partial" && unread.envelope.error?.code === "OPERATION_PARTIAL", shown(unread));
  check("the warning names the unread census and every agent's managed is unknown", unread.envelope?.warnings.some((w) => w.code === "MANAGERS_UNREAD") === true && unread.envelope.result?.managers === "unread" && Object.values(rowsOf(unread)).every((r) => r.managed === null), { warnings: unread.envelope?.warnings, managers: unread.envelope?.result?.managers });
  const unreadPlain = await run(["who", "--plain"]);
  check("the report still prints, with managed shown as unknown", unreadPlain.status === 4 && /alice\/builder\s+working.*unknown/.test(unreadPlain.stdout) && /MANAGERS_UNREAD|could not ask the managers/.test(unreadPlain.stderr), shown(unreadPlain));

  // ── a credential that may not read the roster ───────────────────────────────────────────────────
  const probe = join(home, "probe.creds");
  writeFileSync(probe, await mintCreds(auth, newIdentity(), "probe"), { mode: 0o600 });
  const denied = await run(["who", "--json", "--creds", probe, "--space", space, "--server", servers]);
  check("a credential that may not read presence is a PERMISSION_DENIED refusal, exit 2, not an empty roster", denied.status === 2 && denied.envelope?.outcome === "refused" && denied.envelope.error?.code === "PERMISSION_DENIED" && denied.envelope.result === null, shown(denied));

  // ── whoami ──────────────────────────────────────────────────────────────────────────────────────
  const me = await run(["whoami", "--json"]);
  check("whoami on a signer's mesh is one complete envelope naming the signer", me.status === 0 && me.envelope?.outcome === "ok" && me.envelope.result?.identity?.kind === "space-signer" && me.envelope.result.read === "all" && me.envelope.result.dms === true, shown(me));
  const mePlain = await run(["whoami", "--plain"]);
  check("its report names the space and what the identity may do", mePlain.status === 0 && new RegExp(`space:\\s+${space}`).test(mePlain.stdout) && /identity:\s+this machine's space signer/.test(mePlain.stdout) && /capabilities:\s+all/.test(mePlain.stdout), shown(mePlain));
  const open = await run(["whoami", "--space", "openmesh", "--json"]);
  check("whoami on an open mesh says nothing is authenticated", open.status === 0 && open.envelope?.result?.identity?.kind === "open", shown(open));
  const noCreds = await run(["whoami", "--creds", probe, "--json"]);
  check("whoami takes no --creds: it is a usage error", noCreds.status === 1 && noCreds.envelope?.error?.code === "USAGE_INVALID", shown(noCreds));
  const both = await run(["who", "--json", "--plain"]);
  check("who --json --plain is one USAGE_INVALID envelope", both.status === 1 && both.envelope?.error?.code === "USAGE_INVALID", shown(both));
} finally {
  for (const ep of endpoints) await ep.stop().catch(() => {});
  await provisioner?.stop().catch(() => {});
  await killAndAwaitExit(broker);
  releaseBroker();
  releaseHome();
}

// ── the managed decision, from census answers ─────────────────────────────────────────────────────
{
  const { judgeSeats } = await import("../src/commands/who.js");
  const seat = (uid: string) => ({ lifecycleUid: uid });
  const every = judgeSeats({ items: [seat("u1")], target: { space: "s", scope: "all-managers" }, warnings: [] });
  check("every manager answered: a listed seat is managed and an unlisted one is not", every.managers === "complete" && every.runs(seat("u1")) === true && every.runs(seat("u2")) === false && every.runs({}) === false && every.warnings.length === 0 && every.labels.length === 0, every.managers);
  const some = judgeSeats({ items: [seat("u1")], target: { space: "s", scope: "all-managers" }, warnings: [{ code: "MANAGER_SILENT", target: {}, message: "m" }], partial: { message: "p", remedy: "r" } });
  check("an incomplete census can only say a listed seat is managed", some.managers === "partial" && some.runs(seat("u1")) === true && some.runs(seat("u2")) === null && some.warnings.length === 1, some.warnings);
  const one = judgeSeats({ items: [seat("u1")], target: { space: "s", scope: "manager", managerInstanceId: "i" }, warnings: [] });
  check("one manager's answer leaves other seats unknown and says so", one.managers === "partial" && one.runs(seat("u2")) === null && [...one.warnings, ...one.labels].some((w) => w.code === "MANAGED_SCOPE"), one);
  check("that answer is a label, not a part left unread", one.warnings.length === 0 && one.labels.length === 1, one);
}

// ── whoami for each user-auth grant state, through a stub provider ────────────────────────────────
{
  const userHome = mkdtempSync(join(tmpdir(), "cotal-whoami-user-"));
  const release = teardownPathOnSignal(userHome);
  mkdirSync(join(userHome, ".cotal"), { recursive: true });
  process.env.COTAL_HOME = join(userHome, ".cotal");
  let status: unknown = {};
  registry.register({ kind: "auth-provider", name: "whoami-smoke", async userStatus() { if (status instanceof Error) throw status; return status; } } as unknown as import("@cotal-ai/core").AuthProvider);
  recordMesh({ space: "usermesh", server: "nats://127.0.0.1:1", root: userHome, mode: "user", origin: "manual", userAuth: { provider: "cotal", idp: { url: "https://idp.example", issuer: "https://idp.example", audience: "cotal-mesh" } }, ts: new Date().toISOString() } as Parameters<typeof recordMesh>[0]);
  const { whoami } = await import("../src/commands/whoami.js");
  const call = async () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
    process.exitCode = 0;
    try {
      await whoami({ positionals: [], values: { space: "usermesh", json: true }, raw: [] });
    } finally {
      process.stdout.write = write;
    }
    const code = process.exitCode;
    process.exitCode = 0;
    return { code, env: JSON.parse(out.join("").trim()) as Envelope };
  };
  const later = Math.floor(Date.now() / 1000) + 3600;
  status = { idpUrl: "https://idp.example" };
  const out = await call();
  check("a user who is not signed in has no principal and no grant", out.code === 0 && out.env.result?.identity?.principal === null && Array.isArray(out.env.result.read) && (out.env.result.read as unknown[]).length === 0, out.env.result);
  status = { idpUrl: "https://idp.example", login: { sub: "sub-1", expiresAt: later }, owner: "u_owner", grant: "not-granted" };
  const denied = await call();
  check("a signed-in user without a grant reads and posts nothing", denied.code === 0 && denied.env.result?.identity?.principal === "u_owner.cli" && denied.env.result.identity.grant === "not-granted" && (denied.env.result.post as unknown[]).length === 0, denied.env.result);
  status = { idpUrl: "https://idp.example", login: { sub: "sub-1", expiresAt: later }, owner: "u_owner", grant: { scope: ["spawn"], allowSubscribe: ["general"], allowPublish: ["general", "ops"] } };
  const granted = await call();
  check("a granted user reports the ledger's read, post and scope", granted.code === 0 && JSON.stringify(granted.env.result?.read) === '["general"]' && JSON.stringify(granted.env.result?.post) === '["general","ops"]' && JSON.stringify(granted.env.result?.capabilities) === '["spawn"]' && granted.env.result?.dms === false, granted.env.result);
  status = { idpUrl: "https://idp.example", login: { sub: "sub-1", expiresAt: later }, owner: "u_owner" };
  const remote = await call();
  check("a grant ledger on another machine is a partial read, exit 4", remote.code === 4 && remote.env.outcome === "partial" && remote.env.warnings.some((w) => w.code === "GRANT_NOT_LOCAL") && remote.env.result?.read === null, remote.env);
  release();
}

finish();
