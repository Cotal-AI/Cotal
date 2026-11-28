/**
 * LIVE: a restart refused for a busy broker port keeps the completed stop on record, so the
 * stop preview before and after the refusal reports the same no-op.
 *
 * Before the fix the refused `up` wrote its own operation into the stack journal before the
 * occupied-address check, replacing the completed `down`; the next `down --dry-run` then printed
 * a whole-stack stop plan for a stack that was still stopped. The journal is now written only
 * once the broker address checks pass, so a refusal there leaves the recorded completed stop
 * in place and both previews report the stack is not running.
 *
 * Driven through the REAL binary as a subprocess, against a REAL broker. The failing case mirrors
 * the reported sequence exactly (foreground start, external stop, a non-NATS listener takes the
 * old address, stop preview, refused restart, stop preview again), and the journal on disk is
 * read back to confirm the recorded operation is still the completed stop.
 *
 * Sandboxes COTAL_HOME and a project root under a scratch base with proven-clean `.cotal` ancestry;
 * kills only its own children. Needs `nats-server` on PATH.
 * Run: pnpm smoke:down-refused-restart:live  (BUILD FIRST - the subprocess runs built dist.)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join, resolve as resolvePath } from "node:path";
import { makeScratch, assertScratchHeld } from "../../../bin/smoke/_scratch.js";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const scratch = makeScratch("cotal-down-refused-restart-");
const home = mkdtempSync(join(scratch, "home-"));
const root = mkdtempSync(join(scratch, "root-"));
const caller = mkdtempSync(join(scratch, "caller-"));
const configDir = join(home, "xdg");
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
process.env.COTAL_HOME = home;

const WT = resolvePath(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
// Loading tsx into node makes the child the CLI itself; the `.bin/tsx` shim would relay only SIGINT
// and SIGTERM and orphan it.
const TSX_IMPORT = import.meta.resolve("tsx");

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** The ambient environment with every `COTAL_` key stripped, then this smoke's own sandbox put
 *  back: a suite run from a mesh-joined session would otherwise point the real CLI at the caller's
 *  mesh and pass while doing it. Enforced by bin/smoke/suite-ambient-env.smoke.ts. */
const sandboxEnv = (() => {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) if (key.startsWith("COTAL_")) delete copy[key];
  return { ...copy, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
})();

const kids: ChildProcess[] = [];
async function run(args: string[], cwd = root): Promise<{ status: number | null; out: string; stdout: string }> {
  const options = { cwd, env: sandboxEnv, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
  assertSmokeSandboxDown(sandbox, args, options);
  const cp = spawn(process.execPath, ["--import", TSX_IMPORT, CLI, ...args], options);
  kids.push(cp);
  let stdout = "", stderr = "";
  cp.stdout?.on("data", (b: Buffer) => { stdout += b.toString(); });
  cp.stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });
  await once(cp, "exit");
  return { status: cp.exitCode, out: `${stdout}${stderr}`, stdout };
}

/** A foreground `up` that stays alive until the stack stops; the caller waits for readiness on
 *  its output and for its exit after an external stop. The exit promise is attached at spawn:
 *  attaching it after the stop would miss an exit that already fired. */
function runForeground(args: string[]): { cp: ChildProcess; out: () => string; exited: Promise<unknown> } {
  const cp = spawn(process.execPath, ["--import", TSX_IMPORT, CLI, ...args], { cwd: root, env: sandboxEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  kids.push(cp);
  let out = "";
  cp.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
  cp.stderr?.on("data", (b: Buffer) => { out += b.toString(); });
  return { cp, out: () => out, exited: once(cp, "exit") };
}

/** Whether the loopback listener answers a TCP connect right now. */
function serving(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((res) => {
    const sock = net.connect(port, "127.0.0.1");
    const done = (v: boolean) => { try { sock.destroy(); } catch { /* already gone */ } res(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on("error", () => done(false));
    sock.on("connect", () => done(true));
  });
}

async function waitServing(port: number, want: boolean, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await serving(port)) === want) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function waitFor(text: () => string, needle: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (text().includes(needle)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The recorded operation in the root's stack journal. */
function journalOperation(): { kind: string; phase: string } {
  const journal = JSON.parse(readFileSync(join(root, ".cotal", "stack-controller.json"), "utf8")) as { operation: { kind: string; phase: string } };
  return journal.operation;
}

async function checkLegacyBrokerPidfile(port: number): Promise<void> {
  const path = join(realpathSync(root), ".cotal", "nats.pid");
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const closed = new Promise<void>((resolve) => unrelated.once("close", () => resolve()));
  try {
    await once(unrelated, "spawn");
    writeFileSync(path, `${unrelated.pid}\n`, { flag: "wx" });
    try {
      const status = await run(["status", "--plain"]);
      const ps = await run(["ps", "--plain"]);
      const up = await run(["up", "--plain"]);
      const diagnosis = `the legacy broker PID file ${path} blocks controller startup; it records PID ${unrelated.pid}`;
      const remedy = up.out.split("\nNext\n")[1]?.trim();
      ok("status, ps and up agree on the legacy broker PID file that blocks restart",
        status.status === 0 && ps.status === 2 && up.status === 2 && ps.out.includes("TARGET_UNAVAILABLE") && up.out.includes("LIFECYCLE_BLOCKED")
        && remedy !== undefined && remedy.includes(`check the executable and command line of PID ${unrelated.pid}`)
        && remedy.includes("Only if you verify that the file does not belong to a running broker, set it aside outside .cotal")
        && [status, ps, up].every(({ out }) => out.includes(diagnosis) && out.includes(remedy) && !out.includes("start it again with")
          && (process.platform !== "linux" || out.includes("current executable is not nats-server"))), { status, ps, up });
      ok("the broker stays stopped and the unrelated process and PID file are left alone",
        !(await serving(port)) && unrelated.kill(0) && readFileSync(path, "utf8") === `${unrelated.pid}\n`);
    } finally { rmSync(path); }
  } finally {
    unrelated.kill();
    await closed;
  }
}

async function checkContractShortcut(space: string, server: string): Promise<void> {
  const offline = mkdtempSync(join(scratch, "offline-"));
  const offlineServer = `nats://127.0.0.1:${await freePort()}`;
  const added = await run(["space", "add", "shortcut-other", "--server", offlineServer, "--root", ".", "--mode", "open", "--force", "--plain"], offline);
  ok("a second space is registered for the contract shortcut check", added.status === 0, added.out);
  const selected = await run(["use", "shortcut-other", "--plain"], caller);
  ok("the caller selects the other space", selected.status === 0, selected.out);
  const listed = await run(["endpoints", "--space", space, "--server", server, "--plain"], caller);
  const shortcut = /^  (cotal endpoint describe .*?) {2,}Resolve a native endpoint/m.exec(listed.stdout)?.[1];
  ok("live presence prints a contract shortcut with the same space and broker",
    listed.status === 0 && shortcut === `cotal endpoint describe <endpoint> --plain --space ${space} --server ${server}`, listed.out);
  const contract = await run(shortcut!.replace("<endpoint>", "manager").split(" ").slice(1), caller);
  ok("following the shortcut reads the original space's verified contract",
    contract.status === 0 && contract.stdout.startsWith(`Mesh: ${space}\n`) && contract.stdout.includes("Verified endpoint contract"), contract.out);
  const restored = await run(["use", space, "--plain"], caller);
  ok("the lifecycle checks keep the original space selected", restored.status === 0, restored.out);
}

let listener: net.Server | undefined;
try {
  assertScratchHeld(root, "down refused-restart fixture");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "lifecycle-stress";

  const created = await run(["space", "create", space, "--plain"]);
  ok("space is created", created.status === 0, created.out.slice(-500));

  const referenceFile = join(root, "manager-reference.json");
  writeFileSync(referenceFile, JSON.stringify({ schemaVersion: 1, space, endpoint: "manager" }));
  for (const name of ["report-a", "retained"]) {
    const added = await run(["endpoint", "add", name, "--space", space, "--file", referenceFile, "--json"]);
    ok(`saved ${name} without a running broker`, added.status === 0, added.out);
  }
  const unconfirmed = await run(["endpoint", "remove", "report-a", "--space", space, "-j"]);
  const retry: string | undefined = /`([^`]+)`/.exec(JSON.parse(unconfirmed.stdout).error?.remedy ?? "")?.[1];
  ok("the removal confirmation keeps the space and JSON presentation",
    unconfirmed.status === 1 && retry === `cotal endpoint remove report-a --space ${space} --yes --json`, unconfirmed.out);
  const removed = await run(retry!.split(" ").slice(1), caller);
  const removal = JSON.parse(removed.stdout);
  ok("following the confirmation removes the reference and returns a JSON receipt",
    removed.status === 0 && removed.out === removed.stdout && removal.target?.space === space &&
    removal.result?.kind === "reference-removal" && removal.result.removed === true, removed.out);

  const fg = runForeground(["up", "--foreground", "--server", server]);
  ok("foreground stack starts and reports readiness",
    await waitFor(fg.out, "Controller stack started", 120_000) && await waitServing(port, true), fg.out().slice(-800));
  await checkContractShortcut(space, server);

  const described = await run(["endpoint", "describe", "manager", "--space", space, "--json"]);
  const instance = JSON.parse(described.stdout).result?.responder.instanceId;
  ok("manager describes its live instance", described.status === 0 && typeof instance === "string", described.out.slice(-800));
  const invoke = ["endpoint", "invoke", "manager", "resolve-cwd", "--space", space, "--args", JSON.stringify({ cwd: root })];
  const active = await run([...invoke, "--on", instance, "--timeout", "5000", "--json"]);
  ok("invoking the live pin resolves the project directory", active.status === 0 && JSON.parse(active.stdout).result?.data?.cwd === realpathSync(root), active.out);
  const absent = "z".repeat(30);
  const stale = await run([...invoke, "--on", absent, "--timeout", "500", "--json"]);
  const staleDoc = JSON.parse(stale.stdout);
  ok("invoking an absent pin refuses without calling the live manager",
    stale.status === 2 && staleDoc.outcome === "refused" && staleDoc.result === null && staleDoc.target?.requestedInstanceId === absent &&
    staleDoc.error?.code === "TARGET_UNAVAILABLE" && staleDoc.error?.message.includes(`pinned instance ${absent} of manager did not answer`) &&
    staleDoc.error.message.includes("500ms --timeout") && staleDoc.error.message.includes("no invocation was sent"), stale.out);
  ok("an unanswered pin advises checking the same space or giving that pin more time",
    staleDoc.error?.remedy.includes(`\`cotal endpoint list --live --space ${space} --json\``) && staleDoc.error.remedy.includes("--timeout 10000") &&
    staleDoc.error.remedy.includes("if you expect that instance to answer") && !staleDoc.error.remedy.includes("start the service"), stale.out);

  const stopped = await run(["down", "--yes"]);
  ok("external down stops the stack", stopped.status === 0, stopped.out.slice(-800));
  await fg.exited;
  ok("foreground launcher exits after the stop", fg.cp.exitCode === 0, `exit ${fg.cp.exitCode}: ${fg.out().slice(-500)}`);
  ok("loopback listener closes after the stop", await waitServing(port, false));
  ok("the completed stop is on record", (() => { const op = journalOperation(); return op.kind === "down" && op.phase === "completed"; })(), JSON.stringify(journalOperation()));
  await checkLegacyBrokerPidfile(port);

  const inventory = ["endpoint", "list", "--live", "--space", space];
  const partial = await run([...inventory, "--json"], caller);
  const partialDoc = JSON.parse(partial.stdout);
  const stoppedMessage = `"${space}" is stopped; its last operation, \`cotal down\`, completed`;
  const restart = `start it again with \`cotal up\` in ${realpathSync(root)}`;
  ok("stopped live inventory keeps saved references and the classified restart guidance in JSON",
    partial.status === 4 && partialDoc.outcome === "partial" && partialDoc.completeness === "partial" && partialDoc.target?.space === space &&
    partialDoc.result?.liveCompleteness === "partial" && partialDoc.result.live === null &&
    partialDoc.result.items.map((item: { name: string }) => item.name).join(",") === "retained" &&
    partialDoc.result.liveUnavailable?.code === "TARGET_UNAVAILABLE" && partialDoc.result.liveUnavailable.message === stoppedMessage &&
    partialDoc.error?.code === "OPERATION_PARTIAL" && partialDoc.error.remedy === restart, partial.out);
  const inventoryText = await run([...inventory, "--plain"], caller);
  ok("stopped live inventory names the completed stop and restart folder in plain output",
    inventoryText.status === 4 && inventoryText.stdout.includes("retained") && inventoryText.stdout.includes(stoppedMessage) &&
    inventoryText.stdout.split("\nNext\n")[1]?.trim() === restart, inventoryText.out);
  const clear = await run(["ps", "--plain", "--space", space], caller);
  // The command word depends on whether the host has a `cotal` launcher on PATH; the restart folder does not.
  const offersRestart = (out: string): boolean =>
    ["cotal", "pnpm cotal"].some((cli) => out.includes(`start it again with \`${cli} up\` in ${realpathSync(root)}`));
  ok("ps offers the normal restart while the saved address is free",
    clear.status === 2 && /Code:\s+TARGET_UNAVAILABLE/.test(clear.out) && offersRestart(clear.out), clear.out);

  listener = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => { listener!.once("error", reject); listener!.listen(port, "127.0.0.1", () => resolve()); });
  ok("a non-NATS listener holds the old address", await serving(port));
  const namesRemedy = (out: string): boolean => ["cotal", "pnpm cotal"].some((cli) =>
    out.includes(`stop the process listening on 127.0.0.1:${port}, then run \`${cli} up\` in ${realpathSync(root)}; this stack keeps its recorded address`));
  for (const [label, flags, cwd] of [
    ["from the stopped project", [], root],
    ["with the saved broker", ["--space", space, "--server", server], caller],
  ] as const) {
    const ps = await run(["ps", "--plain", ...flags], cwd);
    ok(`ps ${label} names the occupied address and how to restart`,
      ps.status === 2 && /Code:\s+TARGET_UNAVAILABLE/.test(ps.out) && ps.out.includes(`another process holds that address 127.0.0.1:${port}`)
      && namesRemedy(ps.out) && !offersRestart(ps.out), ps.out);
  }

  const first = await run(["down", "--dry-run"]);
  ok("first stop preview exits 0 and reports the no-op",
    first.status === 0 && first.out.includes("is not running") && first.out.includes("Nothing was stopped"), first.out.slice(-800));

  const refused = await run(["up", "--foreground"]);
  ok("refused restart exits 2 with the occupied-address refusal",
    refused.status === 2 && refused.out.includes("started no member") && refused.out.includes("CONFLICT") && refused.out.includes("address already in use"), refused.out.slice(-1200));

  const second = await run(["down", "--dry-run"]);
  ok("second stop preview exits 0 and reports the same no-op",
    second.status === 0 && second.out.includes("is not running") && second.out.includes("Nothing was stopped"), second.out.slice(-800));
  ok("second stop preview shows no whole-stack stop plan",
    !second.out.includes("Whole-stack stop plan"), second.out.slice(-800));
  ok("the refused restart left the completed stop on record",
    (() => { const op = journalOperation(); return op.kind === "down" && op.phase === "completed"; })(), JSON.stringify(journalOperation()));

  console.log(`\ndown-refused-restart live smoke: OK - ${pass} checks`);
} finally {
  if (listener) await new Promise<void>((resolve) => listener!.close(() => resolve()));
  for (const cp of kids) { try { cp.kill("SIGKILL"); } catch { /* already gone */ } }
}
