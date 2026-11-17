/** Drive private connection-bundle exports through the built CLI. The native bundle producer and
 * registration writer create the fixtures; no broker, login session or signer export is used.
 * Private generated credentials remain in the printed fixture directory for scoped cleanup. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "space-export-"));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
Object.assign(process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "xdg"), DO_NOT_TRACK: "1", NO_COLOR: "1", CI: "1" });
const { createSpaceAuth } = await import("@cotal-ai/core");
const { composeUserBundle, createCalloutAuth, finalizeUserBundleEndpoint } = await import("@cotal-ai/auth");
process.env.COTAL_HOME = join(home, ".cotal");
const { checkBundleDocument, findMesh, recordMesh } = await import("@cotal-ai/workspace");
const { remoteUserEntry } = await import("../src/commands/meshes-add.js");
const bin = process.env.SPACE_EXPORT_CLI ?? join(import.meta.dirname, "../../../bin/dist/cotal.js");
assert.ok(existsSync(bin), "build the CLI before this suite");
const root = join(home, "project"), output = join(home, "exports");
for (const dir of [root, output]) mkdirSync(dir, { mode: 0o700 });
const auth = await createSpaceAuth("exported");
const callout = await createCalloutAuth({ space: "exported", operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const raw = composeUserBundle({ space: "exported", server: "wss://mesh.example/ws", idp: { url: "https://identity.example", issuer: "https://identity.example", audience: "export-test" }, sentinelCreds: callout.sentinelCreds, agentProvisioningUrl: "https://mesh.example/agents" });
finalizeUserBundleEndpoint(raw, "https://mesh.example/exchange");
const checked = checkBundleDocument({ ...raw, policy: { events: "required" } });
assert.ok(checked.ok);
checked.value.userAuth.endpoints.managerAuthorityUrl = "https://mesh.example/authority";
const original = remoteUserEntry("exported", checked.value.server, root, checked.value, true, false);
recordMesh(original);
let ran = 0, failed = 0;
function check(name: string, ok: boolean): void { ran++; if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}`); }
function run(args: string[]) {
  const child = spawnSync(process.execPath, [bin, ...args], { cwd: home, env: process.env, encoding: "utf8", timeout: 30_000 });
  let report: { outcome?: string; error?: { code?: string }; result?: { path?: string } } | undefined;
  try { report = JSON.parse(child.stdout); } catch { /* Plain/help output has no JSON report. */ }
  check("command output contains no fixture credential or signing material", ![callout.sentinelCreds, auth.operator.seed, auth.account.signingSeed].some(value => child.stdout.includes(value) || child.stderr.includes(value)));
  return { ...child, report };
}
const file = join(output, "connection.json");
const first = run(["space", "export", "exported", "--out", file, "--json"]);
check("registered remote space exports through the public CLI", first.status === 0 && first.report?.outcome === "ok" && existsSync(file));
if (process.argv.includes("--baseline")) {
  console.log(`space-export baseline: ${ran - failed} passed, ${failed} failed; fixture ${home}`);
  process.exit(failed ? 1 : 0);
}
assert.ok(existsSync(file), "the primary export must exist before round-trip checks");
const written = readFileSync(file, "utf8"), parsed = checkBundleDocument(JSON.parse(written));
check("export passes the native importer validator", parsed.ok);
check("all connection pins, policy and sentinel survive unchanged", parsed.ok && JSON.stringify(parsed.value) === JSON.stringify(checked.value));
check("private publication mode", process.platform === "win32" || (statSync(file).mode & 0o777) === 0o600);
check("no local custody path or account signing key in bundle", !written.includes(home) && !written.includes(auth.operator.seed) && !written.includes(auth.account.signingSeed));
check("registration stays unchanged", JSON.stringify(findMesh("exported")) === JSON.stringify(original));
const again = run(["space", "export", "exported", "--out", file, "--json"]);
check("existing output refuses without overwrite", again.status === 2 && again.report?.error?.code === "CONFLICT" && readFileSync(file, "utf8") === written);
const linked = join(output, "linked.json"); symlinkSync(file, linked);
const link = run(["space", "export", "exported", "--out", linked, "--json"]);
check("symlink output refuses without modifying its target", link.status === 2 && link.report?.error?.code === "CONFLICT" && readFileSync(file, "utf8") === written);
const missing = run(["space", "export", "absent", "--out", join(output, "absent.json"), "--json"]);
check("unknown space refuses without output", missing.status === 2 && missing.report?.error?.code === "TARGET_NOT_FOUND" && !existsSync(join(output, "absent.json")));
const noOut = run(["space", "export", "exported", "--json"]);
check("output path is mandatory", noOut.status === 1 && noOut.report?.error?.code === "USAGE_INVALID");
const managedPath = join(home, ".cotal", "forbidden.json");
const managed = run(["space", "export", "exported", "--out", managedPath, "--json"]);
check("managed state cannot be an export destination", managed.status === 2 && managed.report?.error?.code === "LIFECYCLE_BLOCKED" && !existsSync(managedPath));
recordMesh({ ...original, mode: "open", userAuth: undefined });
const open = run(["space", "export", "exported", "--out", join(output, "open.json"), "--json"]);
check("open mode refuses", open.status === 2 && open.report?.error?.code === "UNSUPPORTED" && !existsSync(join(output, "open.json")));
recordMesh({ ...original, mode: "auth", userAuth: undefined });
const staticAuth = run(["space", "export", "exported", "--out", join(output, "static.json"), "--json"]);
check("static signing authority is never substituted", staticAuth.status === 2 && staticAuth.report?.error?.code === "UNSUPPORTED" && !existsSync(join(output, "static.json")));
recordMesh({ ...original, userAuth: { ...original.userAuth!, remote: undefined } });
const local = run(["space", "export", "exported", "--out", join(output, "local.json"), "--json"]);
check("local auth without a remote connection contract refuses", local.status === 2 && local.report?.error?.code === "UNSUPPORTED");
recordMesh(original);
const sentinel = original.userAuth!.sentinelCredsPath!;
renameSync(sentinel, sentinel + ".held");
const missingSentinel = run(["space", "export", "exported", "--out", join(output, "missing-sentinel.json"), "--json"]);
check("missing sentinel refuses without output", missingSentinel.status === 2 && missingSentinel.report?.error?.code === "TARGET_NOT_FOUND" && !existsSync(join(output, "missing-sentinel.json")));
renameSync(sentinel + ".held", sentinel);
writeFileSync(sentinel, "not a credential", { mode: 0o600 });
const malformed = run(["space", "export", "exported", "--out", join(output, "malformed.json"), "--json"]);
check("malformed sentinel refuses without output", malformed.status === 1 && malformed.report?.error?.code === "SCHEMA_INVALID" && !existsSync(join(output, "malformed.json")));
writeFileSync(sentinel, callout.calloutCreds, { mode: 0o600 });
const privileged = run(["space", "export", "exported", "--out", join(output, "privileged.json"), "--json"]);
check("a real callout service credential cannot substitute for the sentinel", privileged.status === 1 && privileged.report?.error?.code === "SCHEMA_INVALID" && !existsSync(join(output, "privileged.json")));
writeFileSync(sentinel, callout.sentinelCreds, { mode: 0o600 });
if (process.platform !== "win32") {
  chmodSync(sentinel, 0o644);
  const exposed = run(["space", "export", "exported", "--out", join(output, "exposed.json"), "--json"]);
  check("nonprivate sentinel refuses before output", exposed.status === 2 && exposed.report?.error?.code === "PERMISSION_DENIED" && !existsSync(join(output, "exposed.json")));
  chmodSync(sentinel, 0o600);
}
recordMesh({ ...original, userAuth: { ...original.userAuth!, sentinelCredsPath: file } });
const foreign = run(["space", "export", "exported", "--out", join(output, "foreign.json"), "--json"]);
check("sentinel outside selected-space custody refuses", foreign.status === 1 && foreign.report?.error?.code === "SCHEMA_INVALID" && !existsSync(join(output, "foreign.json")));
recordMesh({ ...original, origin: "catalog", catalogOwner: "fixture-account", catalogRoot: root });
const unbound = run(["space", "export", "exported", "--out", join(output, "unbound-catalog.json"), "--json"]);
check("unbound catalog exports its existing connection snapshot", unbound.status === 0 && readFileSync(join(output, "unbound-catalog.json"), "utf8") === written);
const project = join(home, "bound-project"); mkdirSync(project, { mode: 0o700 });
recordMesh({ ...original, origin: "catalog", catalogOwner: "fixture-account", catalogRoot: root, root: project });
const catalog = run(["space", "export", "exported", "--out", join(output, "catalog.json"), "--json"]);
check("project-bound catalog exports without moving custody", catalog.status === 0 && readFileSync(join(output, "catalog.json"), "utf8") === written && findMesh("exported")?.catalogRoot === root && findMesh("exported")?.root === project);
const plain = run(["space", "export", "exported", "--out", join(output, "plain.json"), "--plain"]);
check("plain receipt names the output", plain.status === 0 && plain.stdout.includes(join(output, "plain.json")));
const help = run(["space", "export", "--help"]);
check("command help advertises required private output", help.status === 0 && help.stdout.includes("--out"));
const canonical = dirname(sentinel), legacy = join(dirname(canonical), "exported");
writeFileSync(join(canonical, "idp.json"), JSON.stringify(original.userAuth!.idp), { mode: 0o600 });
renameSync(canonical, legacy);
recordMesh({ ...original, userAuth: { ...original.userAuth!, sentinelCredsPath: join(legacy, "sentinel.creds") } });
const oldLayout = run(["space", "export", "exported", "--out", join(output, "legacy.json"), "--json"]);
check("legacy custody refuses without migrating or publishing", oldLayout.status === 2 && oldLayout.report?.error?.code === "LIFECYCLE_BLOCKED" && existsSync(legacy) && !existsSync(canonical) && !existsSync(join(output, "legacy.json")));
console.log(`space-export: ${ran - failed} passed, ${failed} failed; fixture ${home}`);
assert.equal(ran, process.platform === "win32" ? 41 : 43, "the suite ran every named check");
assert.equal(failed, 0);
