/**
 * LIVE: `auth revoke-credential` stops one minted credential and keeps the store.
 *
 *  1. On a running stack it refuses LIFECYCLE_BLOCKED (exit 2), naming `cotal down`, the revocation
 *     and `cotal up`, and the account record is unchanged.
 *  2. After `down`, without `--yes` it refuses USAGE_INVALID (exit 1). With `--yes` it records the
 *     key from the creds file in the account JWT's revocations, and again by public key it reports
 *     the same time and changes nothing. doctor auth lists the file as revoked, naming a mint with a
 *     new key and the file's read, post and role grants, and its heading says one exported file needs
 *     attention. A creds file another account
 *     issued refuses CONFLICT. A word that is no public key and names no file, and a missing file,
 *     refuse TARGET_NOT_FOUND naming the path; a 0644 file refuses with its chmod. The stack's own
 *     system-account credentials refuse UNSUPPORTED, naming `cotal up --rotate-sys`.
 *  3. After `up`, the broker refuses the revoked credential, and the refusal names the revocation and
 *     a new key with the file's grants, for `who` and `send`; `whoami --creds` reports when the key
 *     was revoked. Another minted credential still reads, and the channel history is kept. `auth mint
 *     --identity` refuses the revoked key, CONFLICT, and a fresh mint works. A post that fresh file
 *     may not make names its post grant, read from the file.
 *
 * Sandboxes COTAL_HOME and every project root. Run: pnpm smoke:auth-revoke-credential:live
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const { getSpaceAuth, shellPath, workspaceSecretStore } = await import("@cotal-ai/workspace");

const { check, finish } = createSuite();
const anchors = new Map<string, SmokeSandboxAnchor>();
const roots: string[] = [];

type Envelope = { outcome: string; error?: { code: string; message: string; remedy?: string }; result?: Record<string, unknown> };
type Run = { status: number | null; signal: NodeJS.Signals | null; spawnError: string | null; stdout: string; stderr: string; env?: Envelope };
const cli = (cwd: string, ...args: string[]): Run => {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 180_000 };
  assertSmokeSandboxDown(anchors.get(cwd), args, options);
  const run = spawnSync(process.execPath, ["--import", TSX_IMPORT, CLI, ...args], options);
  let parsed: Envelope | undefined;
  try { parsed = JSON.parse(run.stdout) as Envelope; } catch { parsed = undefined; }
  return { status: run.status, signal: run.signal, spawnError: run.error?.message ?? null, stdout: run.stdout, stderr: run.stderr, env: parsed };
};
const shown = (run: Run) => ({ status: run.status, signal: run.signal, spawnError: run.spawnError, error: run.env?.error, out: run.stdout.slice(-1000), err: run.stderr.slice(-1500) });
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
  const mintLeaked = cli(root, "auth", "mint", "leaked", "--no-expiry", "--allow-subscribe", "general", "--allow-publish", "general", "--role", "rev", "--out", leaked, "--json");
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
  let revocation: unknown;
  {
    const before = accountDigest(root);
    const unconfirmed = cli(root, "auth", "revoke-credential", leaked, "--json");
    check("without --yes it refuses USAGE_INVALID, exit 1, and changes nothing", unconfirmed.status === 1 && unconfirmed.env?.error?.code === "USAGE_INVALID" && accountDigest(root) === before, shown(unconfirmed));
    const revoked = cli(root, "auth", "revoke-credential", leaked, "--yes", "--json");
    const result = revoked.env?.result ?? {};
    revocation = result.revokedAt;
    check("with --yes it revokes the creds file's key, to take effect at the next up",
      revoked.status === 0 && result.publicKey === key && result.source === "creds-file" && result.alreadyRevoked === false && result.takesEffect === "next-up" && typeof result.revokedAt === "number", shown(revoked));
    const auth = await getSpaceAuth(workspaceSecretStore(root), space);
    check("the space's account JWT now revokes that key at that time", auth !== undefined && accountRevocations(auth.account.jwt)[key] === result.revokedAt);
    const again = cli(root, "auth", "revoke-credential", key, "--yes", "--json");
    check("by public key again it reports the same time and changes nothing",
      again.status === 0 && again.env?.outcome === "no-op" && again.env.result?.alreadyRevoked === true && again.env.result.revokedAt === result.revokedAt, shown(again));
    const doctor = cli(root, "doctor", "auth", "--json");
    const exported = (doctor.env?.result?.exported ?? []) as { path: string; state: string; repair: string | null }[];
    const listed = exported.find((row) => row.path === leaked);
    check("doctor auth lists the revoked file, and its repair is a mint with a new key and the file's grants, since --identity refuses that key",
      listed?.state === "revoked" && listed.repair?.includes("auth mint --identity refuses that key; mint a new key with the grants this file holds:") === true
        && listed.repair.includes("auth mint leaked --allow-subscribe general --allow-publish general --role rev --out <new file>")
        && exported.find((row) => row.path === kept)?.state === "unbounded", { exported, doctor: shown(doctor) });
    const heading = cli(root, "doctor", "auth");
    check("  and its heading says there are no findings and that one exported file needs attention",
      heading.status === 0 && heading.stdout.includes("No findings; 1 exported credential file needs attention") && !heading.stdout.includes("No local credential findings"), shown(heading));
    const foreign = join(creds, "foreign.creds");
    writeFileSync(foreign, await mintCreds(await createSpaceAuth("elsewhere"), newIdentity(), "agent", { lifecycleUid: mintLifecycleUid() }), { mode: 0o600 });
    const other = cli(root, "auth", "revoke-credential", foreign, "--yes", "--json");
    check("a creds file another account issued refuses CONFLICT, exit 2", other.status === 2 && other.env?.error?.code === "CONFLICT", shown(other));
    const unchanged = accountDigest(root);
    const word = cli(root, "auth", "revoke-credential", "UNOTAKEY", "--yes", "--json");
    check("a word that is no public key and names no file refuses TARGET_NOT_FOUND, saying both",
      word.status === 2 && word.env?.error?.code === "TARGET_NOT_FOUND" && word.env.error.message === `"UNOTAKEY" is not a user public key, and no file is at ${join(realpathSync.native(root), "UNOTAKEY")}; nothing was revoked`, shown(word));
    const missing = join(creds, "missing.creds");
    const absent = cli(root, "auth", "revoke-credential", missing, "--yes", "--json");
    check("a creds file that does not exist refuses TARGET_NOT_FOUND, naming it",
      absent.status === 2 && absent.env?.error?.code === "TARGET_NOT_FOUND" && absent.env.error.message === `the referenced credential ${missing} does not exist`, shown(absent));
    const loose = join(creds, "loose.creds");
    copyFileSync(kept, loose);
    chmodSync(loose, 0o644);
    const open = cli(root, "auth", "revoke-credential", loose, "--yes", "--json");
    check("a creds file other accounts can read refuses PERMISSION_DENIED, with the chmod that fixes it",
      open.status === 2 && open.env?.error?.code === "PERMISSION_DENIED" && open.env.error.remedy === `chmod 600 ${shellPath(loose)}`, shown(open));
    const spaceDir = readdirSync(join(root, ".cotal")).find((name) => name.startsWith("space."));
    for (const file of ["connection-evictor.creds", "membership-observer.creds"]) {
      const sys = cli(root, "auth", "revoke-credential", join(root, ".cotal", spaceDir ?? "", file), "--yes", "--json");
      check(`the stack's own ${file} refuses UNSUPPORTED as a system-account credential, with --rotate-sys as its Next`,
        sys.status === 2 && sys.env?.error?.code === "UNSUPPORTED"
          && sys.env.error.message === `the credential was issued by space ${space}'s system account, and auth revoke-credential revokes only credentials the space's own account issued; nothing was revoked`
          && sys.env.error.remedy === `cotal down --yes, then cotal up --rotate-sys, from ${root}, issues a new system account and retires this one's credentials; full backups taken before it can no longer be restored`, shown(sys));
    }
    check("  and none of them changes the account record", accountDigest(root) === unchanged);
  }

  // 3. The next up loads it: the one credential is refused, the rest and the store stay.
  {
    const restarted = cli(root, "up", "--server", server, "--json");
    check("up starts the stack again", restarted.status === 0, shown(restarted));
    const refused = cli(root, "who", "--json", "--creds", leaked, "--space", space, "--server", server);
    check("the broker refuses the revoked credential, PERMISSION_DENIED", refused.status === 2 && refused.env?.error?.code === "PERMISSION_DENIED", shown(refused));
    // The account here records the revocation, so the refusal names it and a mint with the file's grants.
    const revokedAt = new Date(Number(revocation) * 1000).toISOString();
    check("  and names the revoked key, its file and when it was revoked",
      refused.env?.error?.message === `credentials rejected at ${server}: the key ${key} in ${leaked} was revoked at ${revokedAt} with auth revoke-credential`, refused.env?.error);
    check("  and its Next is a new key with the grants the file held",
      refused.env?.error?.remedy === "a revoked key is not signed again; mint a new key with the grants it held: cotal auth mint <label> --allow-subscribe general --allow-publish general --role rev --out <new file>", refused.env?.error);
    const sendRevoked = cli(root, "send", "-c", "general", "after the revocation", "--json", "--creds", leaked, "--space", space, "--server", server);
    check("send with the revoked file names the revocation too", sendRevoked.status === 2 && sendRevoked.env?.error?.message === refused.env?.error?.message, shown(sendRevoked));
    const whoRevoked = cli(root, "whoami", "--creds", leaked, "--json");
    const whoKept = cli(root, "whoami", "--creds", kept, "--json");
    check("whoami --creds reports when the file's key was revoked, and null for a key that was not",
      whoRevoked.env?.result?.revokedAt === revokedAt && whoKept.status === 0 && whoKept.env?.result?.revokedAt === null, { revoked: shown(whoRevoked), kept: shown(whoKept) });
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
    // A --creds agent file holds its own post grant, so a refused post names it.
    const unposted = cli(root, "send", "-c", "general", "no post grant", "--json", "--creds", join(creds, "fresh.creds"), "--space", space, "--server", server);
    check("a post the fresh file may not make names its post grant, read from the file",
      unposted.status === 2 && unposted.env?.error?.code === "PERMISSION_DENIED" && unposted.env.error.remedy === `this identity may post to no channel in ${space}`, shown(unposted));
  }
} finally {
  if (anchors.has(root)) cli(root, "down", "--yes", "--json");
}
finish();
