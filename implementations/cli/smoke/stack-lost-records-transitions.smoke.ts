/** Real stack lifecycles keep recovery process pins attached to their exact instances. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox, skipSuite } from "@cotal-ai/smoke-kit";
import { assertRecordIdentity } from "@cotal-ai/workspace";
import type { StatusResult } from "../src/commands/status-model.js";

if (process.platform !== "linux") skipSuite("stack-lost-records-transitions: Linux creation-pinned recovery");
const base = process.env.COTAL_LOST_HOME_TRANSITIONS_ROOT ?? mkdtempSync(join(tmpdir(), "cotal-home-transitions-"));
mkdirSync(base, { recursive: true, mode: 0o700 });
const binary = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
interface Pin { pid: number; token: string }
interface Journal { members: { role: string; instanceId: string | null; process?: Pin }[] }
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`); }
}
for (const scenario of ["forget", "managerless", "settled", "repeat", "broker-only", "manager-backed"]) {
  const fixture = join(base, scenario), home = join(fixture, "home"), root = join(fixture, "project");
  for (const path of [fixture, home, root]) mkdirSync(path, { mode: 0o700 });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key))), HOME: fixture, XDG_CONFIG_HOME: join(fixture, "xdg"), COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1" };
  let anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: env.XDG_CONFIG_HOME });
  const file = join(root, ".cotal", "stack-controller.json");
  const journal = (): Journal => JSON.parse(readFileSync(file, "utf8")) as Journal;
  const pins = new Map<string, Pin>();
  const remember = () => {
    if (existsSync(file)) for (const row of journal().members) if (row.process) pins.set(`${row.process.pid}:${row.process.token}`, row.process);
  };
  const gone = (pin: Pin) => ["gone", "mismatch"].includes(assertRecordIdentity(pin).kind);
  const cli = (args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 150_000 };
    assertSmokeSandboxDown(anchor, args, options);
    const result = spawnSync(process.execPath, [binary, ...args, "--json"], options);
    if (result.error) throw new Error("owned CLI invocation did not complete");
    const data = JSON.parse(result.stdout) as { outcome?: string; error?: { code?: string; message?: string }; result?: unknown };
    remember();
    return { exit: result.status, data };
  };
  const must = (args: string[]) => {
    const result = cli(args);
    if (result.exit !== 0) throw new Error(`fixture preparation failed: ${JSON.stringify(result)}`);
  };
  let hidden = false;
  const hide = () => {
    renameSync(home, `${home}-retained`); hidden = true;
    mkdirSync(home, { mode: 0o700 });
    anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: env.XDG_CONFIG_HOME });
  };
  try {
    must(["space", "create", scenario]);
    if (scenario === "broker-only") {
      must(["up", "--open", "--no-manager", "--space", scenario, "--server", `nats://127.0.0.1:${await freePort()}`]);
      const [pin] = pins.values();
      if (pins.size !== 1 || !pin || gone(pin)) throw new Error("expected one live broker pin");
      const status = () => {
        const read = cli(["status"]);
        const report = read.data.result as StatusResult;
        return { exit: read.exit, folder: report.folder, selected: report.selected, hints: report.hints, broker: report.folder.processes?.find((row) => row.name === "nats") };
      };
      const intact = status();
      check("intact home: named broker-only stack is selected and backed by its instance record",
        intact.exit === 0 && intact.selected.resolved && intact.selected.space === scenario && intact.broker?.ownedService?.pid === pin.pid, intact);
      hide();
      const before = readFileSync(file, "utf8");
      const lost = status();
      check("missing home: status succeeds and shows the creation-pinned broker running, without an instance record",
        lost.exit === 0 && lost.folder.processSpace === scenario && lost.folder.controllerStack && !lost.folder.storedState &&
        lost.broker?.state === "running" && lost.broker.pid === pin.pid && lost.broker.ownedService === null, lost);
      const next = lost.hints.join("\n");
      check("missing home: status names the lost records and recommends preview then stop, not cleanup or recreation",
        !lost.selected.resolved && lost.selected.message.includes("member records are missing") &&
        /`(?:pnpm )?cotal down --dry-run`.*`(?:pnpm )?cotal down --yes`/.test(next) && !/clean store|reset store|space create/.test(next), lost);
      const components = spawnSync(process.execPath, [binary, "status", "--components"], { cwd: root, env, encoding: "utf8", timeout: 150_000 });
      const health = components.stdout.split("Component Health")[1] ?? "";
      check("component health refuses the service check and reports the same running broker pin and recovery step",
        components.status === 3 && /target\s+refused/.test(health) && !/target\s+absent/.test(health) &&
        health.includes("broker process is running") && health.includes(`broker pid ${pin.pid}`) &&
        /`(?:pnpm )?cotal down --dry-run`.*`(?:pnpm )?cotal down --yes`/.test(health), components.stdout + components.stderr);
      const preview = cli(["down", "--dry-run"]);
      const result = preview.data.result as { kind?: string; signalled?: boolean; members?: { role: string; process: string; pid: number }[] };
      check("recovery preview agrees with status and neither writes the journal nor signals the broker",
        preview.exit === 0 && result.kind === "missing-records-stack-stop-preview" && result.signalled === false &&
        result.members?.some((row) => row.role === "broker" && row.process === "running" && row.pid === pin.pid) === true &&
        readFileSync(file, "utf8") === before && !gone(pin), preview);
      must(["down", "--yes"]);
      check("after recovery status does not report the exited broker as running", gone(pin) && status().broker?.state !== "running");
      continue;
    }
    if (scenario === "manager-backed") {
      must(["up", "--open", "--space", scenario, "--server", `nats://127.0.0.1:${await freePort()}`]);
      const started = journal();
      const manager = started.members.find((row) => row.role === "manager")?.process;
      const broker = started.members.find((row) => row.role === "broker")?.process;
      if (!manager || !broker || gone(manager) || gone(broker)) throw new Error("expected live manager and broker pins");
      hide();
      const before = readFileSync(file, "utf8");
      const lost = cli(["status"]);
      const report = lost.data.result as StatusResult;
      const managerRow = report.folder.processes?.find((row) => row.name === "manager");
      const brokerRow = report.folder.processes?.find((row) => row.name === "nats");
      check("missing home: status shows the creation-pinned manager and broker running",
        lost.exit === 0 && report.folder.processSpace === scenario && managerRow?.state === "running" && managerRow.pid === manager.pid &&
        brokerRow?.state === "running" && brokerRow.pid === broker.pid && brokerRow.ownedService === null, { managerRow, brokerRow, selected: report.selected });
      check("missing home: status names both running processes and keeps the preview",
        report.selected.resolved === false && report.selected.message.includes("manager and broker processes are running") &&
        /`(?:pnpm )?cotal down --dry-run`.*`(?:pnpm )?cotal down --yes`/.test(report.hints.join("\n")), report.selected);
      const components = spawnSync(process.execPath, [binary, "status", "--components"], { cwd: root, env, encoding: "utf8", timeout: 150_000 });
      const health = components.stdout.split("Component Health")[1] ?? "";
      check("component health refuses the service check and names both running pins",
        components.status === 3 && /target\s+refused/.test(health) && !/target\s+absent/.test(health) &&
        health.includes("manager and broker processes are running") && health.includes(`manager pid ${manager.pid}`) &&
        health.includes(`broker pid ${broker.pid}`) && /`(?:pnpm )?cotal down --dry-run`.*`(?:pnpm )?cotal down --yes`/.test(health), components.stdout + components.stderr);
      const preview = cli(["down", "--dry-run"]);
      const result = preview.data.result as { kind?: string; signalled?: boolean; members?: { role: string; process: string; pid: number }[] };
      check("recovery preview agrees with status and writes nothing",
        preview.exit === 0 && result.kind === "missing-records-stack-stop-preview" && result.signalled === false &&
        result.members?.some((row) => row.role === "manager" && row.process === "running" && row.pid === manager.pid) === true &&
        result.members?.some((row) => row.role === "broker" && row.process === "running" && row.pid === broker.pid) === true &&
        readFileSync(file, "utf8") === before && !gone(manager) && !gone(broker), preview);
      must(["down", "--yes"]);
      check("after recovery neither pinned process is still running", gone(manager) && gone(broker));
      continue;
    }
    must(["up", "--server", `nats://127.0.0.1:${await freePort()}`]);
    check(`${scenario}: real up records three live member identities`, pins.size === 3 && [...pins.values()].every((pin) => assertRecordIdentity(pin).kind === "match"));
    if (scenario === "repeat") {
      hide();
      const recovered = cli(["down", "--yes"]);
      check("recovery stops every exact original member", recovered.exit === 0 && [...pins.values()].every(gone), recovered);
    } else {
      must(["down", "--yes"]);
      check(`${scenario}: ordinary down stops every exact member`, [...pins.values()].every(gone));
    }
    if (scenario === "forget") {
      const forgotten = cli(["space", "forget", scenario]);
      check("ordinary up/down/forget succeeds without a partial retirement", forgotten.exit === 0, forgotten);
      check("retired members carry neither instance IDs nor process pins", journal().members.every((row) => row.instanceId === null && row.process === undefined));
    } else if (scenario === "managerless") {
      const manager = journal().members.find((row) => row.role === "manager")!;
      must(["up", "--no-manager"]);
      const current = journal().members.find((row) => row.role === "manager")!;
      check("managerless restart retains the stopped manager's matching creation pin", current.instanceId === manager.instanceId && JSON.stringify(current.process) === JSON.stringify(manager.process));
      const live = [...pins.values()].filter((pin) => assertRecordIdentity(pin).kind === "match");
      check("managerless restart has only broker and delivery running", live.length === 2);
      hide();
      const stopped = cli(["down", "--yes"]);
      check("lost-home stop succeeds after a full then managerless lifecycle", stopped.exit === 0 && live.every(gone), stopped);
    } else {
      if (scenario === "settled") hide();
      const before = readFileSync(file, "utf8");
      const stopped = cli(["down"]);
      check(`${scenario}: an already stopped stack needs no fresh confirmation`, stopped.exit === 0, stopped);
      check(`${scenario}: bare repeated stop leaves the settled journal unchanged`, readFileSync(file, "utf8") === before);
      const repeated = cli(["down", "--yes"]);
      check(`${scenario}: confirmed repeat is also a no-write no-op`, repeated.exit === 0 && readFileSync(file, "utf8") === before, repeated);
    }
  } finally {
    if (hidden) {
      if (existsSync(home)) renameSync(home, `${home}-recreated`);
      renameSync(`${home}-retained`, home);
      anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: env.XDG_CONFIG_HOME });
    }
    if ([...pins.values()].some((pin) => !gone(pin))) {
      const cleanup = cli(["down", "--yes"]);
      if (cleanup.exit !== 0) throw new Error(`owned cleanup refused: ${JSON.stringify(cleanup)}`);
    }
    if (![...pins.values()].every(gone)) throw new Error("an owned creation-pinned member remains running");
  }
}
console.log(`STACK LOST RECORD TRANSITIONS ${failed ? "FAILED" : "OK"} (${passed} passed, ${failed} failed)`);
if (failed) process.exitCode = 1;
