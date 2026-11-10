/** Live shipped-CLI regression for credentials exported before a local identity reset. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";

const repo = resolve(import.meta.dirname, "../../..");
const cliPath = join(repo, "bin/cotal.ts");
const tsx = import.meta.resolve("tsx");
const base = mkdtempSync(join(tmpdir(), "cotal-reset-credential-"));
const home = join(base, "home"), root = join(base, "project"), keys = join(base, "keys"), xdg = join(base, "xdg");
for (const dir of [home, root, keys, xdg]) mkdirSync(dir, { mode: 0o700 });
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
Object.assign(env, { COTAL_HOME: home, XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" });
let anchor: SmokeSandboxAnchor | undefined;
type Envelope = { outcome?: string; target?: { space?: string; path?: string }; error?: { code?: string; message?: string; remedy?: string }; warnings?: { code: string; message: string }[]; result?: { items?: { text: string }[]; grants?: { read: string[]; post: string[]; role: string | null } } };
function cli(cwd: string, ...args: string[]) {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 };
  assertSmokeSandboxDown(cwd === root ? anchor : undefined, args, options);
  const result = spawnSync(process.execPath, ["--import", tsx, cliPath, ...args], options);
  assert.ifError(result.error);
  assert.equal(result.signal, null, "CLI must finish without a signal");
  let envelope: Envelope | undefined;
  if (args.includes("--json")) envelope = JSON.parse(result.stdout) as Envelope;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, envelope };
}
function ok(cwd: string, ...args: string[]) {
  const run = cli(cwd, ...args);
  assert.equal(run.status, 0, `${args[0]} failed: ${run.stderr || run.stdout}`);
  return run;
}
const failures: string[] = [];
function check(label: string, test: () => void) {
  try { test(); console.log(`PASS ${label}`); }
  catch (error) { failures.push(label); console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`); }
}
const space = "resetcreds";
const stale = join(keys, "before.creds"), fresh = join(keys, "after.creds");
const observer = join(keys, "observer.creds");
const empty = join(keys, "empty.creds"), emptyReplacement = join(keys, "empty-replacement.creds");
const server = `nats://127.0.0.1:${await freePort()}`;
const warning = "Credentials exported with auth mint --out will stop working on this space after the next up. Mint replacements after up with `cotal auth mint <label> --out <new file>`. Exported files are not removed; no remote credential is revoked.";
try {
  ok(home, "space", "create", space, "--root", root, "--json");
  anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
  ok(root, "up", "--server", server, "--no-manager", "--json");
  ok(root, "auth", "mint", "ana", "--allow-subscribe", "general", "--allow-publish", "general", "--role", "reviewer", "--out", stale, "--json");
  ok(root, "auth", "mint", "watcher", "--profile", "observer", "--out", observer, "--json");
  const emptyMint = ok(root, "auth", "mint", "emptyagent", "--allow-subscribe", "", "--allow-publish", "", "--out", empty, "--json");
  assert.deepEqual(emptyMint.envelope?.result?.grants, { read: [], post: [], role: null, fromIdentity: [] });
  ok(root, "persona", "create", "emptyagent", "--prompt", "test persona", "--subscribe", "general", "--role", "worker", "--json");
  ok(root, "down", "--yes", "--json");
  const preview = ok(root, "reset", "space", space, "--dry-run");
  const previewJson = ok(root, "reset", "space", space, "--dry-run", "--json");
  check("reset preview warns about exported credentials in text", () => assert.ok(preview.stderr.includes(warning), preview.stderr));
  check("reset preview warns about exported credentials in JSON", () => assert.ok(previewJson.envelope?.warnings?.some((row) => row.code === "EXPORTED_CREDENTIALS_INVALIDATED" && row.message === warning)));
  const receipt = ok(root, "reset", "space", space, "--yes");
  check("reset receipt warns about exported credentials", () => assert.ok(receipt.stderr.includes(warning), receipt.stderr));
  assert.match(receipt.stdout, /Remote revocation:\s+not performed/);
  ok(root, "up", "--json");
  for (const [label, args] of [
    ["send", ["send", "-c", "general", "stale"]],
    ["history", ["history", "general"]],
    ["who", ["who", "--all"]],
  ] as const) {
    const text = cli(root, ...args, "--creds", stale, "--plain");
    const json = cli(root, ...args, "--creds", stale, "--json");
    assert.equal(text.status, 2);
    assert.equal(json.status, 2);
    assert.equal(json.envelope?.error?.code, "PERMISSION_DENIED");
    console.log(`OBSERVED ${label} ${JSON.stringify(json.envelope?.error)}`);
    check(`${label} names the replaced local identity`, () => {
      assert.ok(json.envelope?.error?.message?.includes(`space "${space}" has a different local identity`));
      assert.ok(text.stderr.includes(`space "${space}" has a different local identity`));
      assert.equal(json.envelope?.target?.space, space);
      assert.equal(json.envelope?.target?.path, stale);
    });
    check(`${label} names a new mint with the file's grants`, () => {
      const remedy = json.envelope?.error?.remedy ?? "";
      assert.ok(remedy.includes("cotal auth mint <label>"));
      assert.ok(remedy.includes("--allow-subscribe general --allow-publish general --role reviewer"));
      assert.ok(remedy.includes("--out <new file>"));
      assert.ok(remedy.includes("--no-persona"));
      assert.ok(text.stderr.includes(remedy));
    });
  }
  const observerRefusal = cli(root, "who", "--all", "--creds", observer, "--space", space, "--server", server, "--json");
  assert.equal(observerRefusal.status, 2);
  assert.equal(observerRefusal.envelope?.error?.code, "PERMISSION_DENIED");
  assert.ok(observerRefusal.envelope?.error?.message?.includes(`space "${space}" has a different local identity`));
  assert.ok(observerRefusal.envelope?.error?.remedy?.includes("cotal auth mint <label> --profile observer --out <new file>"));
  console.log("PASS observer replacement retains its profile with explicit matching --server");
  const emptyRefusal = cli(root, "who", "--all", "--creds", empty, "--json");
  assert.equal(emptyRefusal.status, 2);
  assert.ok(emptyRefusal.envelope?.error?.remedy?.includes("cotal auth mint <label> --allow-subscribe '' --allow-publish '' --no-persona --out <new file>"));
  const emptyRepair = ok(root, "auth", "mint", "emptyagent", "--allow-subscribe", "", "--allow-publish", "", "--no-persona", "--out", emptyReplacement, "--json");
  assert.deepEqual(emptyRepair.envelope?.result?.grants, { read: [], post: [], role: null, fromIdentity: [] });
  ok(root, "who", "--all", "--creds", emptyReplacement, "--json");
  console.log("PASS following the empty-grant repair ignores a preserved matching persona and retains no role");
  const personaControl = ok(root, "auth", "mint", "emptyagent", "--out", join(keys, "persona-control.creds"), "--json");
  assert.deepEqual(personaControl.envelope?.result?.grants, { read: ["general"], post: [], role: "worker", fromIdentity: [] });
  const flagged = ok(root, "auth", "mint", "emptyagent", "--no-persona", "--allow-subscribe", "ops", "--allow-publish", "ops", "--role", "reviewer", "--out", join(keys, "explicit.creds"), "--json");
  assert.deepEqual(flagged.envelope?.result?.grants, { read: ["ops"], post: ["ops"], role: "reviewer", fromIdentity: [] });
  const carried = ok(root, "auth", "mint", "emptyagent", "--no-persona", "--identity", emptyReplacement, "--out", join(keys, "carried.creds"), "--json");
  assert.deepEqual(carried.envelope?.result?.grants, { read: [], post: [], role: null, fromIdentity: ["read", "post", "role"] });
  for (const profile of ["observer", "admin"]) {
    const refused = cli(root, "auth", "mint", "no_persona", "--no-persona", "--profile", profile, "--out", join(keys, `${profile}-invalid.creds`), "--json");
    assert.equal(refused.status, 1);
    assert.equal(refused.envelope?.error?.code, "USAGE_INVALID");
  }
  console.log("PASS persona defaults remain opt-in to the original path, explicit grants hold, and fixed profiles refuse --no-persona");
  ok(root, "auth", "mint", "ana", "--allow-subscribe", "general", "--allow-publish", "general", "--role", "reviewer", "--out", fresh, "--json");
  ok(root, "send", "--creds", fresh, "-c", "general", "fresh control", "--json");
  const history = ok(root, "history", "general", "--creds", fresh, "--json");
  assert.deepEqual(history.envelope?.result?.items?.map((row) => row.text), ["fresh control"]);
  ok(root, "who", "--all", "--creds", fresh, "--json");
  console.log("PASS fresh credential positive controls: send, history, who");
} finally {
  ok(root, "down", "--yes", "--json");
  // Retain the isolated sandbox, including its stopped stack records, for failure diagnosis.
  console.log(`Retained stopped sandbox: ${base}`);
}
assert.deepEqual(failures, [], "stale credential guidance regressions");
