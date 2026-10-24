/**
 * LIVE: `auth revoke-credential` stops one minted credential and keeps the store.
 *
 *  1. On a running stack it refuses LIFECYCLE_BLOCKED (exit 2), naming `cotal down`, the revocation
 *     and `cotal up`, and the account record is unchanged.
 *  2. After `down`, without `--yes` it refuses USAGE_INVALID (exit 1). With `--yes` it records the
 *     key from the creds file in the account JWT's revocations, and again by public key it reports
 *     the same time and changes nothing. A creds file another account issued refuses CONFLICT.
 *  3. After `up`, the broker refuses the revoked credential, another minted credential still reads,
 *     and the channel history is kept. `auth mint --identity` refuses the revoked key, CONFLICT, and
 *     a fresh mint works.
 *
 * Sandboxes COTAL_HOME and every project root. Run: pnpm smoke:auth-revoke-credential:live
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { accountRevocations, createSpaceAuth, mintCreds, mintLifecycleUid, newIdentity } from "@cotal-ai/core";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";

const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX_IMPORT = import.meta.resolve("tsx");
const home = mkdtempSync(join(tmpdir(), "cotal-revoke-credential-"));
const configDir = join(home, "xdg");
// The CLI children must not inherit a managed session's mesh identity from whatever runs this
// suite; they get only the private home and the values set below.
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_HOME = home;
const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
const { getSpaceAuth, workspaceSecretStore } = await import("@cotal-ai/workspace");

const { check, finish } = createSuite();
const anchors = new Map<string, SmokeSandboxAnchor>();
const roots: string[] = [];

type Envelope = { outcome: string; error?: { code: string; message: string; remedy?: string }; result?: Record<string, unknown> };
type Run = { status: number | null; stdout: string; stderr: string; env?: Envelope };
const cli = (cwd: string, ...args: string[]): Run => {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 180_000 };
  assertSmokeSandboxDown(anchors.get(cwd), args, options);
  const run = spawnSync(process.execPath, ["--import", TSX_IMPORT, CLI, ...args], options);
  let parsed: Envelope | undefined;
  try { parsed = JSON.parse(run.stdout) as Envelope; } catch { parsed = undefined; }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, env: parsed };
};
const shown = (run: Run) => ({ status: run.status, error: run.env?.error, out: run.stdout.slice(-1000), err: run.stderr.slice(-1500) });
const accountDigest = (root: string) => {
  const dir = join(root, ".cotal", "auth");
  if (!existsSync(dir)) return "absent";
  const hash = createHash("sha256");
  for (const name of readdirSync(dir).filter((file) => file.startsWith("account.")).sort()) hash.update(name).update(readFileSync(join(dir, name)));
  return hash.digest("hex");
};
// Project roots and the private credential folder sit beside COTAL_HOME, never inside it.
const folder = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), `cotal-revoke-credential-${name}-`));
  roots.push(root);
  return root;
};

process.on("exit", () => { for (const path of [home, ...roots]) rmSync(path, { recursive: true, force: true }); });

const space = "revoke1";
const root = folder(space);
const creds = folder("creds");
const server = `nats://127.0.0.1:${await freePort()}`;
try {
  const created = cli(home, "space", "create", space, "--root", root, "--json");
  check("space create prepares a root", created.status === 0, shown(created));
  anchors.set(root, recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir }));
  const started = cli(root, "up", "--server", server, "--json");
  check("up starts the stack", started.status === 0, shown(started));
  const sent = cli(root, "send", "-c", "general", "kept through the revocation", "--json");
  check("a message is stored on general", sent.status === 0, shown(sent));
  const leaked = join(creds, "leaked.creds"), kept = join(creds, "kept.creds");
  const mintLeaked = cli(root, "auth", "mint", "leaked", "--no-expiry", "--out", leaked, "--json");
  const mintKept = cli(root, "auth", "mint", "kept", "--no-expiry", "--out", kept, "--json");
  const key = String(mintLeaked.env?.result?.identity ?? "");
  check("auth mint writes two credentials", mintLeaked.status === 0 && mintKept.status === 0 && /^U[A-Z2-7]{55}$/.test(key), { leaked: shown(mintLeaked), kept: shown(mintKept) });

  // 1. A running stack refuses, naming the route, and changes nothing.
  {
    const before = accountDigest(root);
    const live = cli(root, "auth", "revoke-credential", leaked, "--yes", "--json");
    check("on a running stack it refuses LIFECYCLE_BLOCKED, exit 2", live.status === 2 && live.env?.error?.code === "LIFECYCLE_BLOCKED", shown(live));
    check("its next step is down, the revocation, then up, and says the store stays",
      live.env?.error?.remedy === `cotal down --yes, then cotal auth revoke-credential ${leaked} --yes, then cotal up, from ${root}; the store stays`, live.env?.error);
    check("and the account record is unchanged", accountDigest(root) === before);
  }

  const stopped = cli(root, "down", "--yes", "--json");
  check("down --yes stops the stack", stopped.status === 0, shown(stopped));

  // 2. After down: confirmation, the revocation, a repeat, and a foreign credential.
  {
    const before = accountDigest(root);
    const unconfirmed = cli(root, "auth", "revoke-credential", leaked, "--json");
    check("without --yes it refuses USAGE_INVALID, exit 1, and changes nothing", unconfirmed.status === 1 && unconfirmed.env?.error?.code === "USAGE_INVALID" && accountDigest(root) === before, shown(unconfirmed));
    const revoked = cli(root, "auth", "revoke-credential", leaked, "--yes", "--json");
    const result = revoked.env?.result ?? {};
    check("with --yes it revokes the creds file's key, to take effect at the next up",
      revoked.status === 0 && result.publicKey === key && result.source === "creds-file" && result.alreadyRevoked === false && result.takesEffect === "next-up" && typeof result.revokedAt === "number", shown(revoked));
    const auth = await getSpaceAuth(workspaceSecretStore(root), space);
    check("the space's account JWT now revokes that key at that time", auth !== undefined && accountRevocations(auth.account.jwt)[key] === result.revokedAt);
    const again = cli(root, "auth", "revoke-credential", key, "--yes", "--json");
    check("by public key again it reports the same time and changes nothing",
      again.status === 0 && again.env?.outcome === "no-op" && again.env.result?.alreadyRevoked === true && again.env.result.revokedAt === result.revokedAt, shown(again));
    const foreign = join(creds, "foreign.creds");
    writeFileSync(foreign, await mintCreds(await createSpaceAuth("elsewhere"), newIdentity(), "agent", { lifecycleUid: mintLifecycleUid() }), { mode: 0o600 });
    const other = cli(root, "auth", "revoke-credential", foreign, "--yes", "--json");
    check("a creds file another account issued refuses CONFLICT, exit 2", other.status === 2 && other.env?.error?.code === "CONFLICT", shown(other));
  }

  // 3. The next up loads it: the one credential is refused, the rest and the store stay.
  {
    const restarted = cli(root, "up", "--server", server, "--json");
    check("up starts the stack again", restarted.status === 0, shown(restarted));
    const refused = cli(root, "who", "--json", "--creds", leaked, "--space", space, "--server", server);
    check("the broker refuses the revoked credential, PERMISSION_DENIED", refused.status === 2 && refused.env?.error?.code === "PERMISSION_DENIED", shown(refused));
    const reads = cli(root, "who", "--json", "--creds", kept, "--space", space, "--server", server);
    check("another minted credential still reads", reads.status === 0 && reads.env?.outcome === "ok", shown(reads));
    const history = cli(root, "history", "general", "--json");
    const items = (history.env?.result?.items ?? []) as { text?: string }[];
    check("the channel history is kept", history.status === 0 && items.some((item) => item.text === "kept through the revocation"), shown(history));
    const reuse = cli(root, "auth", "mint", "again", "--identity", leaked, "--out", join(creds, "again.creds"), "--json");
    check("auth mint --identity refuses the revoked key, CONFLICT, naming the revocation",
      reuse.status === 2 && reuse.env?.error?.code === "CONFLICT" && reuse.env.error.message.includes(`${key} was revoked at`) && reuse.env.error.remedy === "mint a fresh key: run auth mint without --identity", shown(reuse));
    const fresh = cli(root, "auth", "mint", "fresh", "--out", join(creds, "fresh.creds"), "--json");
    check("a fresh mint works", fresh.status === 0 && fresh.env?.result?.identity !== key, shown(fresh));
  }
} finally {
  if (anchors.has(root)) cli(root, "down", "--yes", "--json");
}
finish();
