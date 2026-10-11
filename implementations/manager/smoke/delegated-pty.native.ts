/** Privileged native library proof, run only in an isolated guest. No model, enrollment or plane.
 * Build this and the child fixture from the same source cohort; this is not hosted acceptance. */
import assert from "node:assert/strict";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SpawnRefused, managedRuntimeKey, type ManagedLifecycleHandoff } from "@cotal-ai/core";
import { createRuntime, type DelegatedPtyOptions } from "../src/runtime/index.js";

if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("this native proof requires an isolated Linux guest-root process");
const root = "/var/lib/cotal-pty-native";
const childEntry = join(root, "program", "child.mjs");
const children = join(root, "children");
const groups = `/sys/fs/cgroup/cotal-pty-native-${process.pid}`;
mkdirSync(children, { mode: 0o711 });
mkdirSync(groups);
mkdirSync(join(root, "manager-private"), { mode: 0o700 });
const dummy = join(root, "manager-private", "dummy");
writeFileSync(dummy, "dummy-no-authority", { mode: 0o600 });
const held = openSync(dummy, "r");
process.env.UNRELATED_HOST_VALUE = "dummy-host-only";
const options: DelegatedPtyOptions = { uid: 65534, gid: 65534, childRoot: children, cgroupRoot: groups, cotalCommand: childEntry,
  env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TERM: "xterm-256color" } };
const handoff: ManagedLifecycleHandoff = { kind: "cotal-managed-handoff/v1", space: "delegatednative", owner: "u_abcdefghijklmnopqrstuv",
  actor: "native_child", lifecycleUid: "abcdefghijklmnopqrstuv1234", server: "nats://127.0.0.1:1", tlsRequired: false,
  authProvider: "cotal", idp: { url: "https://example.invalid", issuer: "https://example.invalid", audience: "https://example.invalid" },
  exchangeUrl: "https://example.invalid", sentinelCreds: "fixture-no-authority", actorToken: "fixture-token-no-authority",
  subscribe: [], allowSubscribe: [], allowPublish: [] };
const resource = join(children, managedRuntimeKey(handoff));
const group = join(groups, managedRuntimeKey(handoff));
let checks = 0;
function check(name: string, test: () => void) { test(); checks++; console.log(`PASS ${name}`); }
async function until(test: () => boolean, label: string) { const end = Date.now() + 10_000; while (Date.now() < end) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error(`timeout: ${label}`); }
const live = (pid: number) => { try { return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8")); } catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; } };
let handle: ReturnType<NonNullable<ReturnType<typeof createRuntime>["spawnDelegated"]>> | undefined;
let observed: Record<string, unknown> | undefined;
try {
  check("default stock runtime remains nondelegated", () => assert.equal(createRuntime("pty", "native-default").spawnDelegated, undefined));
  check("external runtimes refuse the delegated configuration", () => assert.throws(() => createRuntime("absent-native-provider", "native", options), /requires the pty runtime/));
  check("root target UID is refused before material", () => assert.throws(() => createRuntime("pty", "native", { ...options, uid: 0 }), SpawnRefused));
  check("loader environment is refused before material", () => assert.throws(() => createRuntime("pty", "native", { ...options, env: { ...options.env, LD_PRELOAD: "/nonexistent" } }), SpawnRefused));
  check("manager environment names are refused", () => assert.throws(() => createRuntime("pty", "native", { ...options, env: { ...options.env, COTAL_HOME: root } }), SpawnRefused));
  check("configuration fields are closed", () => assert.throws(() => createRuntime("pty", "native", { ...options, extra: true } as DelegatedPtyOptions), SpawnRefused));
  check("ordinary filesystems cannot substitute for confinement", () => assert.throws(() => createRuntime("pty", "native", { ...options, cgroupRoot: root }), SpawnRefused));
  check("refusals release no handoff and reserve no child", () => assert.equal(existsSync(join(children, ".delegated-child")), false));
  const runtime = createRuntime("pty", "native", options);
  check("configured runtime exposes the actual delegated entry", () => assert.equal(typeof runtime.spawnDelegated, "function"));
  check("configured runtime refuses direct launch", () => assert.throws(() => runtime.spawn("bad", { command: "/bin/true", args: [] }, root), SpawnRefused));
  check("handoff unknown fields refuse before allocation", () => assert.throws(() => runtime.spawnDelegated!({ agent: "native-fixture", persona: "fixture" }, { ...handoff, managerSeed: "dummy" } as ManagedLifecycleHandoff), /unknown field/));
  handle = runtime.spawnDelegated!({ agent: "native-fixture", persona: "fixture persona", events: false }, handoff);
  let output = "";
  handle.attach().onData(bytes => { output += bytes.toString("utf8"); });
  await until(() => /DELEGATED_NATIVE_OBSERVATION=(\{[^\r\n]+\})/.test(output), "native child observation");
  observed = JSON.parse(/DELEGATED_NATIVE_OBSERVATION=(\{[^\r\n]+\})/.exec(output)![1]!);
  const o = observed!;
  check("child has the selected UID and GID", () => { assert.equal(o.uid, options.uid); assert.equal(o.gid, options.gid); });
  check("child has no privileged supplementary group", () => assert.ok((o.groups as number[]).every(gid => gid === options.gid)));
  check("child cannot read manager material or regain root", () => { assert.equal(o.readDenied, true); assert.equal(o.rootRegainDenied, true); });
  check("child capabilities and no-new-privileges are observed", () => { assert.equal(o.noNewPrivs, "1"); for (const name of ["capEff", "capPrm", "capBnd", "capAmb"]) assert.equal(o[name], "0000000000000000"); });
  check("child cannot migrate out of its kernel confinement", () => assert.equal(o.migrationDenied, true));
  check("held manager descriptor and unrelated env are absent", () => { assert.equal(o.inherited, false); assert.equal(o.unrelatedHostValue, true); });
  check("handoff crosses only in a private taken file", () => { assert.equal(o.handoffRemoved, true); assert.equal(o.tokenNotInArgv, true); });
  check("home, cwd and temp remain in the keyed child root", () => { assert.equal(o.cwd, resource); assert.equal(o.home, resource); assert.equal(o.temp, resource); });
  check("kernel membership is the lifecycle resource", () => assert.ok(String(o.membership).endsWith("/" + managedRuntimeKey(handoff))));
  check("private directory is child-owned mode0700", () => { const st = lstatSync(resource); assert.equal(st.uid, options.uid); assert.equal(st.mode & 0o777, 0o700); });
  check("one-shot host marker remains root-private", () => { const st = lstatSync(join(children, ".delegated-child")); assert.equal(st.uid, 0); assert.equal(st.mode & 0o777, 0o600); });
  check("runtime reference and release remain absent", () => { assert.equal(handle!.reference, undefined); assert.equal(handle!.release, undefined); });
  check("detached descendant is live before terminal close", () => assert.equal(live(Number(o.descendantPid)), true));
  check("active second allocation is refused", () => assert.throws(() => runtime.spawnDelegated!({ agent: "native-fixture", persona: "fixture" }, handoff), SpawnRefused));
  // Real runtime input ends only the foreground fixture. The setsid descendant ignores HUP/TERM.
  await handle.write!("exit-parent\n");
  await handle.waitForExit!();
  check("reported exit also proves detached descendant death", () => { assert.equal(handle!.status(), "exited"); assert.equal(live(Number(o.descendantPid)), false); });
  check("child storage and cgroup go only after full exit", () => { assert.equal(existsSync(resource), false); assert.equal(existsSync(group), false); });
  check("one-shot marker is retained after close", () => assert.equal(existsSync(join(children, ".delegated-child")), true));
  console.log("DELEGATED_NATIVE_SENTINEL=" + JSON.stringify({ checks, failed: 0, observed: o, exit: handle.exitInfo?.(), scope: "source-runtime/OS proof with dummy fixture, not stock CLI, auth or Lang acceptance" }));
} finally {
  if (handle && handle.status() !== "exited") { handle.stop({ graceful: false }); await handle.waitForExit!(); }
  closeSync(held);
  // Kernel emptiness is mandatory even on a failing assertion. Never delete a live cwd.
  if (existsSync(group)) throw new Error("native proof cleanup retained an unverified cgroup and child root");
  rmdirSync(groups);
  rmSync(root, { recursive: true, force: true });
}
