/**
 * Bare `cotal status` on the structured output contract, driven through the built binary in a fresh
 * sandbox per case: one envelope whose result the report is drawn from, the agreed section order with
 * the hints last and no roster, only the selected registration checked unless `--all` asks for each,
 * a part it cannot read named on its row and reported partial (exit 4) rather than complete, and the
 * usage refusals, and the nats-server it would run named, with one on PATH below the broker floor
 * refused by `up` before any broker starts. A stopped root whose broker kept a store names
 * `reset store <space>` under Next where that reset reaches it, and clean where it cannot.
 * Broker-free: every registration points at a closed port. The live rows are in
 * `smoke:delivery-responder-visibility`, `smoke:component-health`, `smoke:ps-user-mode` and
 * `smoke:up-tls-routes`.
 *
 * Run: pnpm smoke:status-report
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort } from "@cotal-ai/smoke-kit";
import { acquireMaintenanceLock, beginMaintenanceCut, findMesh, recordMesh, releaseMaintenanceLock, renderReport, writeMaintenanceResumeDocument } from "@cotal-ai/workspace";
import { statusView } from "../src/commands/status.js";
import { restoreNextStep } from "../src/lib/restore.js";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}
const { check, finish } = createSuite();
const VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "bin", "package.json"), "utf8")) as { version: string }).version;
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const roots: string[] = [];
process.on("exit", () => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

type Mesh = { space: string; server: string | null; check: string; current: boolean };
type Envelope = {
  outcome: string;
  completeness: string;
  target: { space: string | null; scope: string };
  command: string;
  result: {
    kind: string;
    machine: { nats: string; natsServer: { path: string; version: string | null } | null; natsProblem: string | null };
    extensions?: { items: { label: string; version: string }[] | null };
    folder: { auth: { state: string }; personas: { root: string; default: string; error: string | null }; processes: { name: string; state: string }[] | null };
    meshes: { current: string | null; folder?: string | null; unreadable: { file: string; error: string }[]; items: Mesh[] };
    selected: { resolved: boolean; code?: string; space?: string; server?: string | null; connection?: string };
    maintenance?: { root: string; space: string | null; state: string; attemptId: string | null; next: string | null } | null;
    store?: { state: string; at?: string; cause?: string; path?: string | null };
    hints: string[];
  } | null;
  warnings: { code: string; target: unknown; message: string }[];
  error?: { code: string; message: string };
};

/** A sandboxed home that is also the working directory and its own project root, so the project
 *  lookup cannot climb into a `.cotal` above it. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "cotal-status-report-"));
  roots.push(home);
  mkdirSync(join(home, ".cotal"));
  const run = (args: string[], extraEnv: Record<string, string> = {}, cwd = home) => {
    // No down runs here, and this sandbox records no anchor, so the guard refuses one.
    assertSmokeSandboxDown(undefined, args, { cwd });
    const r = spawnSync(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal-home"), COTAL_SKIP_CONNECTOR_SEED: "1", ...extraEnv },
      encoding: "utf8",
      timeout: 120_000,
    });
    const stdout = r.stdout ?? "";
    const lines = stdout.split("\n").filter(Boolean);
    const envelope = lines.length === 1 && lines[0]!.startsWith("{") ? (JSON.parse(lines[0]!) as Envelope) : undefined;
    return { status: r.status, stdout, stderr: r.stderr ?? "", envelope };
  };
  return { home, run };
}
const shown = (r: { status: number | null; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const titles = (text: string) => text.split("\n").filter((line) => /^[A-Z][A-Za-z ]+$/.test(line));
/** The punctuation `--plain` writes in ASCII, as the workspace renderer maps it. */
const PLAIN_PUNCTUATION: Record<string, string> = { "·": "-", "…": "...", "→": "->", "↳": "->", "—": "-", "–": "-" };
const ascii = (s: string) => s.replace(/[·…→↳—–]/g, (glyph) => PLAIN_PUNCTUATION[glyph]!).replace(/§ ?/g, "section ");
/** A rich report as plain would word it: no ANSI, no state marks, ASCII punctuation. */
const asPlain = (rich: string) => ascii(strip(rich).replace(/[●○] /g, ""));
/** The words of a report, so a column padded around a mark does not count as a different word. */
const words = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

const brokerDisplayOnly = process.argv.includes("--broker-display-only");
let brokerDisplayCases = 0;
if (!brokerDisplayOnly) {
// ── a fresh machine: one envelope, one report, the agreed order ──────────────────────────────────
{
  const { run } = sandbox();
  // A space nothing records: the target stays unresolved, so nothing is dialed.
  const unknown = ["--space", "nosuch"];
  const json = run(["status", ...unknown, "--json"]);
  const env = json.envelope;
  check("status --json is one complete ok envelope", json.status === 0 && env?.outcome === "ok" && env.completeness === "complete" && env.command === "status", shown(json));
  check("its target names no space and the selected scope", env?.target.space === null && env.target.scope === "selected", env?.target);
  check("the result is the infrastructure report with the unresolved target named", env?.result?.kind === "infrastructure" && env.result.selected.resolved === false && env.result.selected.code === "unknown-space", env?.result?.selected);
  check("the result carries no roster", !/"roster"|"presence"/.test(json.stdout), json.stdout.slice(0, 400));
  check("--json writes nothing on stderr", json.stderr === "", json.stderr);

  const rich = run(["status", ...unknown], { FORCE_COLOR: "1" });
  const plain = run(["status", ...unknown, "--plain"], { FORCE_COLOR: "1" });
  const verbose = run(["status", ...unknown, "--plain", "--verbose"]);
  check("status draws a colored report", rich.status === 0 && /\x1b\[/.test(rich.stdout), shown(rich));
  check("--plain writes the same words with no ANSI and ASCII punctuation", plain.status === 0 && !/\x1b\[/.test(plain.stdout) && !/[●○·…→↳—–]/.test(plain.stdout) && words(plain.stdout) === words(asPlain(rich.stdout)), shown(plain));
  check(
    "the sections keep the infrastructure order and end with the hints",
    JSON.stringify(titles(plain.stdout)) === JSON.stringify(["This machine", "Spaces", "Selected space", "Next"]),
    titles(plain.stdout),
  );
  check(
    "--verbose adds the detail sections before Next",
    verbose.status === 0 && JSON.stringify(titles(verbose.stdout)) === JSON.stringify(["This machine", "Spaces", "Selected space", "Machine", "Extensions", "This Folder", "Recorded Meshes", "Selected Mesh", "Next"]),
    titles(verbose.stdout),
  );
  check("the report names no roster", !/roster/i.test(plain.stdout) && !/roster/i.test(verbose.stdout), plain.stdout);
  // The NATS row is in the verbose Machine section; the default view says Broker executable.
  const machine = env?.result?.machine;
  const natsRow = verbose.stdout.split("\n").find((line) => /^ {2}NATS: /.test(line))?.replace(/^ {2}NATS: +/, "");
  const version = machine?.natsServer?.version ? `nats-server ${machine.natsServer.version}` : "nats-server, version not reported";
  const expected = machine?.nats === "missing" ? "missing" : machine?.natsProblem ?? (machine?.nats === "path" ? `${version} on PATH at ${machine.natsServer?.path}` : `bundled ${version} at ${machine?.natsServer?.path}`);
  check("the NATS row names the nats-server it would run, where it came from and its version", natsRow === expected && ["path", "bundled", "missing"].includes(machine?.nats ?? ""), { machine, natsRow });
  check("each hint in the result is printed under Next", (env?.result?.hints ?? []).every((hint) => plain.stdout.split("\nNext\n")[1]?.includes(ascii(hint))), { hints: env?.result?.hints, out: plain.stdout });
  check("no report line ends in padding", [plain.stdout, verbose.stdout].every((out) => out.split("\n").every((line) => !line.endsWith(" "))), plain.stdout);
}

// ── only the selected registration is checked unless --all asks for every one ────────────────────
{
  const { home, run } = sandbox();
  const [a, b] = [await freePort(), await freePort()];
  for (const [space, port] of [["alpha", a], ["beta", b]] as const) {
    const add = run(["meshes", "add", space, "--server", `nats://127.0.0.1:${port}`, "--mode", "open", "--root", home, "--force"]);
    check(`control: ${space} is registered`, add.status === 0, shown(add));
  }
  const byName = (env: Envelope | undefined) => Object.fromEntries((env?.result?.meshes.items ?? []).map((m) => [m.space, m.check]));
  const selected = run(["status", "--space", "alpha", "--json"]);
  check("the selected registration is checked and reported unreachable", byName(selected.envelope).alpha === "unreachable", byName(selected.envelope));
  check("the other registration is not checked", byName(selected.envelope).beta === "not-checked", byName(selected.envelope));
  check("an unreachable selected mesh is a fact, not a partial read", selected.status === 0 && selected.envelope?.completeness === "complete" && selected.envelope.result?.selected.connection === "unreachable", shown(selected));
  // The membership feed's time is shown as an age; the document keeps the ISO time it was read at.
  // The row is in the verbose Selected Mesh section.
  const fed = { ...selected.envelope!.result!, selected: { ...selected.envelope!.result!.selected, membershipFeed: { entries: 2, asOf: new Date(Date.now() - 90_000).toISOString() } } };
  const fedReport = renderReport(statusView(fed as unknown as Parameters<typeof statusView>[0], true), "plain");
  check("the membership feed row says how long ago it was updated", /^ {2}membership feed: +2 entries - updated 1m ago$/m.test(fedReport), fedReport.split("\n").filter((l) => /membership/.test(l)));
  // An interrupted up names its recorded root as one shell argument, including --no-manager.
  for (const reportRoot of [home, join(home, "interrupted O'Neil $HOME")]) for (const noManager of [false, true]) {
    const base = selected.envelope!.result!;
    const interrupted = { ...base, folder: { ...base.folder, root: reportRoot, controllerStack: true, processSpace: "alpha", stackBlock: null,
      stackUnfinished: { kind: "up", id: "interrupted-up", running: noManager ? ["broker"] : ["broker", "delivery"], stopped: noManager ? ["delivery"] : ["manager"], noManager } },
      selected: { ...base.selected, resolved: true, space: "alpha", root: reportRoot, connection: "reachable" } };
    const report = renderReport(statusView(interrupted as unknown as Parameters<typeof statusView>[0]), "plain");
    const rootWord = reportRoot === home ? home : `'${home}/interrupted O'\\''Neil $HOME'`;
    check(`interrupted up keeps its ${reportRoot === home ? "ordinary" : "quoted"} root${noManager ? " and --no-manager" : ""} in Next`,
      report.includes(`cotal up --root ${rootWord}${noManager ? " --no-manager" : ""}`), report);
  }
  // The other restart routes keep their recorded root as one literal shell argument too.
  for (const reportRoot of [home, join(home, "recovery O'Neil $HOME")]) for (const kind of ["down", "streams"] as const) {
    const base = selected.envelope!.result!;
    const recovery = { ...base, folder: { ...base.folder, root: reportRoot, controllerStack: true, processSpace: "alpha", stackBlock: null,
      stackUnfinished: kind === "down" ? { kind: "down", id: "interrupted-down", running: ["broker"], stopped: ["manager", "delivery"] } : null },
      selected: { ...base.selected, resolved: true, space: "alpha", root: reportRoot, connection: "reachable",
        ...(kind === "streams" ? { spaceStreams: { state: "absent", root: reportRoot, stack: "stopped" } } : {}) } };
    const report = renderReport(statusView(recovery as unknown as Parameters<typeof statusView>[0]), "plain");
    const rootWord = reportRoot === home ? home : `'${home}/recovery O'\\''Neil $HOME'`;
    check(`${kind} recovery keeps its ${reportRoot === home ? "ordinary" : "quoted"} root in Next`,
      report.includes(`cotal up --root ${rootWord}`) && report.includes(kind === "down" ? "Or restart this stack" : "Create the space's streams again, empty, and restart"), report);
  }
  // A service outside the stack must be stopped before the restart that refuses beside it.
  for (const heldServices of [[], [{ definition: "dl", instanceId: "held-delivery", record: "delivery", pid: 12345 }], null]) {
    const base = selected.envelope!.result!;
    const stopped = { ...base, folder: { ...base.folder, root: home, controllerStack: true, processSpace: "alpha", stackBlock: null, stackUnfinished: null, heldServices },
      selected: { ...base.selected, resolved: true, space: "alpha", root: home, connection: "unreachable" } };
    const report = renderReport(statusView(stopped as unknown as Parameters<typeof statusView>[0]), "plain");
    const next = report.split("\nNext\n")[1] ?? "";
    const stop = "cotal svc stop dl --instance held-delivery --space alpha --yes", start = `cotal up --root ${home}`;
    check(`restart guidance ${heldServices?.length ? "stops the held service first" : heldServices === null ? "does not invent an unreadable holder" : "keeps the no-holder route"}`,
      heldServices?.length ? next.includes(stop) && next.indexOf(stop) < next.indexOf(start) : next.includes(start) && !next.includes("svc stop"), next);
  }
  // A legacy static-auth stack started here whose broker or manager exited is restarted by a bare
  // `up` in this folder, so Next names it first, ahead of the conditional store reset.
  const cleanHint = "if the stored JetStream state is stale: `cotal clean store --force`, then `up` with your usual flags (`clean all` also resets identity)";
  const legacyNext = (exited: string[], opts: { mode?: string; pid?: number | null; origin?: string; root?: string; controllerStack?: boolean } = {}) => {
    const base = selected.envelope!.result!;
    const processes = ["manager", "delivery", "nats"].map((name) => exited.includes(name) ? { name, state: "stopped", pid: opts.pid === undefined ? 4242 : opts.pid, detail: opts.pid === null ? "no pidfile" : "stale pidfile" } : { name, state: "running", pid: 4343, detail: null });
    const legacy = { ...base, folder: { ...base.folder, root: opts.root ?? home, controllerStack: opts.controllerStack ?? false, processSpace: "alpha", processes, storedState: exited.includes("nats"), stackBlock: null, stackUnfinished: null },
      meshes: { ...base.meshes, items: base.meshes.items.map((m) => m.space === "alpha" ? { ...m, mode: opts.mode ?? "auth", origin: opts.origin ?? "up" } : m) },
      selected: { ...base.selected, resolved: true, space: "alpha", root: home, mode: opts.mode ?? "auth", connection: exited.includes("nats") ? "unreachable" : "reachable" },
      hints: exited.includes("nats") ? [cleanHint] : [] };
    return renderReport(statusView(legacy as unknown as Parameters<typeof statusView>[0]), "plain").split("\nNext\n")[1] ?? "";
  };
  const firstCommand = (next: string) => next.split("\n")[0]?.trim().split(/\s{2,}/) ?? [];
  {
    const [command, description] = firstCommand(legacyNext(["manager"]));
    check("an exited legacy manager puts a bare up first under Next", /(^|\s)cotal up$/.test(command ?? "") && description === "Restart this folder's manager, which exited; pass --runtime again if the manager ran on one", { command, description });
  }
  {
    const next = legacyNext(["nats"]);
    const [command, description] = firstCommand(next);
    check("an exited legacy broker puts a bare up first under Next", /(^|\s)cotal up$/.test(command ?? "") && description === "Restart this folder's broker, which exited; up reopens the recorded store", { command, description });
    check("…ahead of the conditional store reset, which stays", next.includes("clean store --force") && next.indexOf("cotal up") < next.indexOf("clean store --force"), next);
  }
  {
    const [command, description] = firstCommand(legacyNext(["nats", "manager"]));
    check("an exited legacy broker and manager are named together", /(^|\s)cotal up$/.test(command ?? "") && description === "Restart this folder's broker and manager, which exited; up reopens the recorded store; pass --runtime again if the manager ran on one", { command, description });
  }
  for (const [label, next] of [
    ["an open stack", legacyNext(["manager"], { mode: "open" })],
    ["a member with no pidfile", legacyNext(["manager"], { pid: null })],
    ["a registration added by hand", legacyNext(["manager"], { origin: "manual" })],
    ["a status run in another folder", legacyNext(["manager"], { root: join(home, "elsewhere") })],
  ] as const)
    check(`control: ${label} gets no bare up`, !/(^|\s)cotal up(\s{2}|$)/m.test(next), next);
  check("control: a controller stack is not read from legacy pidfiles", !/(^|\s)cotal up(\s{2}|$)/m.test(legacyNext(["manager"], { controllerStack: true })), legacyNext(["manager"], { controllerStack: true }));
  const plain = run(["status", "--space", "alpha", "--plain"]);
  const NOT_DIALED = "Unselected spaces are not dialed - `cotal status --all` dials each";
  check("the other registration carries no connection state, and one note says why, once",
    /^ {2}beta +open$/m.test(plain.stdout) && !/^ {2}\S+ +not checked/m.test(plain.stdout) &&
      (plain.stdout.match(/are not dialed/g) ?? []).length === 1 && plain.stdout.includes(NOT_DIALED), plain.stdout);
  check("the selected space is the first row, marked, with its own dialed state",
    /^ {2}-> alpha +unreachable[^\n]* +open$/m.test(plain.stdout) &&
      plain.stdout.indexOf("-> alpha") < plain.stdout.indexOf("beta "), plain.stdout);
  const wide = run(["status", "--space", "alpha", "--plain", "--wide"]);
  check("--wide groups the spaces under their broker addresses again and keeps their origin",
    new RegExp(`^ {2}nats://127.0.0.1:${a}$`, "m").test(wide.stdout) && new RegExp(`^ {2}nats://127.0.0.1:${b}$`, "m").test(wide.stdout) &&
      /^ {2}-> alpha +unreachable[^\n]* +open - registered endpoint$/m.test(wide.stdout) && !wide.stdout.includes(NOT_DIALED), shown(wide));
  check("control: the default report has no broker address as a group title",
    !new RegExp(`^ {2}nats://127.0.0.1:${a}$`, "m").test(plain.stdout), plain.stdout);
  const all = run(["status", "--space", "alpha", "--all", "--json"]);
  check("--all checks every registration", byName(all.envelope).alpha === "unreachable" && byName(all.envelope).beta === "unreachable", byName(all.envelope));
  check("--all is named in the target", all.envelope?.target.scope === "all" && all.envelope.target.space === "alpha", all.envelope?.target);
  // A `--server` that names another address is the only broker dialed: the selected registration's
  // recorded address is not checked. One that names the recorded address checks it.
  const other = run(["status", "--space", "alpha", "--server", `nats://127.0.0.1:${await freePort()}`, "--json"]);
  check("a --server that names another address leaves the selected registration not checked", byName(other.envelope).alpha === "not-checked" && other.envelope?.result?.selected.connection === "unreachable", { items: byName(other.envelope), connection: other.envelope?.result?.selected.connection });
  const otherPlain = run(["status", "--space", "alpha", "--server", `nats://127.0.0.1:${await freePort()}`, "--plain"]);
  check("…and its row carries no connection state, under the note that says what was dialed",
    /^ {2}-> alpha +open$/m.test(otherPlain.stdout) && !/^ {2}\S+ +not checked/m.test(otherPlain.stdout) && otherPlain.stdout.includes("are not dialed"), otherPlain.stdout);
  const same = run(["status", "--space", "alpha", "--server", `nats://127.0.0.1:${a}`, "--json"]);
  check("control: a --server that names the recorded address checks it", byName(same.envelope).alpha === "unreachable", byName(same.envelope));
  // Under `--all` with a `--server` that names another address, the selected row shows its own
  // address's check: a recorded address that answers reads reachable while `--server` does not.
  // The greeter runs in its own process, because `run` blocks this one.
  const greeter = spawn(process.execPath, ["-e", `const s = require("node:net").createServer((c) => { c.on("error", () => {}); c.end('INFO {"server_id":"row","version":"2.12.12","proto":1,"max_payload":1048576}\\r\\n'); }); s.listen(0, "127.0.0.1", () => console.log(s.address().port));`], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const [port] = (await once(greeter.stdout!, "data")) as [Buffer];
    const add = run(["meshes", "add", "gamma", "--server", `nats://127.0.0.1:${port.toString().trim()}`, "--mode", "open", "--root", home, "--force"]);
    check("control: gamma is registered at an address that answers", add.status === 0, shown(add));
    const allOther = run(["status", "--space", "gamma", "--all", "--server", `nats://127.0.0.1:${await freePort()}`, "--json"]);
    check("--all with a --server that names another address checks the selected registration's own address", byName(allOther.envelope).gamma === "reachable" && allOther.envelope?.result?.selected.connection === "unreachable", { items: byName(allOther.envelope), connection: allOther.envelope?.result?.selected.connection });
    const allOtherPlain = run(["status", "--space", "gamma", "--all", "--server", `nats://127.0.0.1:${await freePort()}`, "--plain"]);
    check("…and its row reports that check, not the --server connection", /-> gamma\s+reachable/.test(allOtherPlain.stdout) && /Connection:\s+unreachable/.test(allOtherPlain.stdout), allOtherPlain.stdout);
  } finally {
    if (greeter.exitCode === null && greeter.signalCode === null) {
      const exited = once(greeter, "exit");
      greeter.kill();
      await exited;
    }
  }
}

// ── a folder's maintenance journal is shown with its full attempt and next step ──────────────────
{
  const { home, run } = sandbox();
  const server = ["--server", `nats://127.0.0.1:${await freePort()}`];
  const none = run(["status", ...server, "--json"]);
  check("control: a folder with no maintenance journal reports none", none.envelope?.result?.maintenance === null, shown(none));
  mkdirSync(join(home, ".cotal", "nats"));
  const lock = acquireMaintenanceLock(home);
  const resume = writeMaintenanceResumeDocument(lock, { version: 1, inventory: { agents: [] }, launch: { runtime: "pty" } });
  beginMaintenanceCut(lock, { attemptId: "cut-status", space: "held", mode: "open", sourcePath: join(home, ".cotal", "nats"), resume, launch: { server: "nats://127.0.0.1:4222" } });
  releaseMaintenanceLock(lock);
  const json = run(["status", ...server, "--json"]);
  const held = json.envelope?.result?.maintenance;
  check("status --json carries the journal's state, space and attempt", held?.state === "cut-intent" && held.space === "held" && held.attemptId === "cut-status", shown(json));
  const plain = run(["status", ...server, "--plain"]);
  check("the report shows it under Maintenance with the attempt", titles(plain.stdout).includes("Maintenance") && /Attempt: +cut-status/.test(plain.stdout), plain.stdout);
  // A held restore names the command that moves it on, with the full attempt id.
  const attempt = "restore-00000000-0000-4000-8000-000000000000";
  const restoring = { ...json.envelope!.result!, maintenance: { root: home, space: "held", state: "restore-ready", attemptId: attempt, next: restoreNextStep("restore-ready", attempt) } };
  const report = renderReport(statusView(restoring as unknown as Parameters<typeof statusView>[0]), "plain");
  check("a held restore names its recover command with the full attempt id", new RegExp(`Attempt: +${attempt}`).test(report) && report.includes(`cotal backup recover ${attempt} --yes`), report);
}

// ── a launch summary recorded at a folder this one was moved from is listed, not unreadable ──────
{
  const { home, run } = sandbox();
  const server = ["--server", `nats://127.0.0.1:${await freePort()}`];
  const before = run(["status", ...server, "--json"]);
  const summaries = join(home, ".cotal", "team-summaries");
  mkdirSync(summaries, { mode: 0o700 });
  const moved = "0123456789abcdef", recordedRoot = `${home}-moved-from`;
  writeFileSync(join(summaries, `${moved}.json`), JSON.stringify({ schemaVersion: 1, kind: "fresh-team-summary", deploymentId: moved, space: "held", root: recordedRoot, server: server[1], authMode: "auth", manifestPath: join(recordedRoot, "cotal.yaml"), requestedAgents: [], declaredChannels: ["general"], recordedAt: new Date().toISOString(), managerRequested: true, controlPlaneReturned: true, authServiceReturned: true, deliveryResponderBound: true, agentReadiness: "not-checked" }), { mode: 0o600 });
  const json = run(["status", ...server, "--json"]);
  const attempts = (json.envelope?.result as { bootAttempts?: { unreadable: string[]; elsewhere: { deploymentId: string; root: string }[] } } | null)?.bootAttempts;
  check("a summary naming the folder it was moved from is not an unreadable record", json.status === before.status && !json.envelope?.warnings.some((w) => w.code === "FRESH_BOOT_RECORD_UNREADABLE") && attempts?.unreadable.length === 0, shown(json));
  check("status --json lists it with the root it was recorded at", attempts?.elsewhere.length === 1 && attempts.elsewhere[0]!.deploymentId === moved && attempts.elsewhere[0]!.root === recordedRoot, attempts);
  const plain = run(["status", ...server, "--plain"]);
  check("the report says where it was recorded", words(plain.stdout).includes(`Launch summary ${moved} was recorded at ${recordedRoot}.`) && !plain.stdout.includes("Unreadable record"), plain.stdout);
  const previousHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = join(home, ".cotal-home");
  try { recordMesh({ space: "held", server: server[1]!, root: home, mode: "open", origin: "manual", ts: new Date().toISOString() }); }
  finally { if (previousHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = previousHome; }
  const show = run(["team", "show", moved, "--space", "held", "--json"]);
  check("team show refuses it with CONFLICT naming the recorded root", show.status === 2 && show.envelope?.error?.code === "CONFLICT" && show.envelope.error.message.includes(`recorded at ${recordedRoot}`), shown(show));
  // Control: a summary that does not parse is still unreadable.
  writeFileSync(join(summaries, "fedcba9876543210.json"), "{", { mode: 0o600 });
  const broken = run(["status", ...server, "--json"]);
  check("control: an unparsable summary is still reported unreadable", broken.envelope?.warnings.some((w) => w.code === "FRESH_BOOT_RECORD_UNREADABLE") === true, shown(broken));
}

// ── a part it cannot read is named on its row, and the read is partial ───────────────────────────
{
  const { home, run } = sandbox();
  // A closed port for this root's mesh, so no broker on this host is dialed.
  const server = ["--server", `nats://127.0.0.1:${await freePort()}`];
  mkdirSync(join(home, ".cotal", "nats.pid"));
  const json = run(["status", ...server, "--json"]);
  const env = json.envelope;
  const nats = env?.result?.folder.processes?.find((p) => p.name === "nats");
  check("an unreadable pidfile makes status partial with exit 4", json.status === 4 && env?.outcome === "partial" && env.completeness === "partial" && env.error?.code === "OPERATION_PARTIAL", shown(json));
  check("the warning names the unreadable pidfile", env?.warnings.some((w) => w.code === "PIDFILE_UNREADABLE" && w.message.includes("nats")) === true, env?.warnings);
  check("its row is reported unreadable and the other rows still are", nats?.state === "unreadable" && (env?.result?.folder.processes ?? []).some((p) => p.name === "manager" && p.state === "stopped"), env?.result?.folder.processes);
  const plain = run(["status", ...server, "--plain", "--verbose"]);
  check("the report still prints, with the row named", plain.status === 4 && /nats:\s+pidfile unreadable/.test(plain.stdout) && /^Selected Mesh$/m.test(plain.stdout), shown(plain));
  check("stderr names the partial read", /PIDFILE|pidfile could not be read/.test(plain.stderr) && /status could not read one part/.test(plain.stderr), plain.stderr);
}
{
  const { home, run } = sandbox();
  mkdirSync(join(home, ".cotal", "auth"));
  writeFileSync(join(home, ".cotal", "auth", "account.alpha.json"), "{not json");
  const json = run(["status", "--server", `nats://127.0.0.1:${await freePort()}`, "--json"]);
  const env = json.envelope;
  check("unreadable trust material is reported partial, not crashed on", json.status === 4 && env?.outcome === "partial" && env.result?.folder.auth.state === "unreadable", shown(json));
  check("its warning is AUTH_UNREADABLE and a hint names the repair", env?.warnings.some((w) => w.code === "AUTH_UNREADABLE") === true && (env?.result?.hints ?? []).some((h) => /repair or remove|check permissions/.test(h)), { warnings: env?.warnings, hints: env?.result?.hints });
}

// ── a persona catalog, the current-mesh pointer or a registry record it cannot read is partial ────
{
  const { home, run } = sandbox();
  // The catalog path exists and is not a directory. An absent one is the empty catalog above.
  writeFileSync(join(home, ".cotal", "agents"), "");
  const json = run(["status", "--space", "nosuch", "--json"]);
  const env = json.envelope;
  check("an unreadable persona catalog is partial with exit 4", json.status === 4 && env?.outcome === "partial" && env.completeness === "partial", shown(json));
  check("the catalog is unreadable, not missing, and its warning names it", env?.result?.folder.personas.default === "unreadable" && env.warnings.some((w) => w.code === "PERSONAS_UNREADABLE" && w.message.includes(env.result!.folder.personas.root)), { personas: env?.result?.folder.personas, warnings: env?.warnings });
  const plain = run(["status", "--space", "nosuch", "--plain", "--verbose"]);
  check("the report names the catalog unreadable, not no default", /personas:\s+unreadable: /.test(plain.stdout) && !/no default/.test(plain.stdout), plain.stdout);
}
{
  const { home, run } = sandbox();
  const pointer = join(home, ".cotal-home", "current-mesh");
  mkdirSync(pointer, { recursive: true });
  const json = run(["status", "--space", "nosuch", "--json"]);
  const env = json.envelope;
  check("an unreadable current-mesh pointer is partial with exit 4", json.status === 4 && env?.outcome === "partial", shown(json));
  check("the pointer is named as unreadable, not read as unset", env?.result?.meshes.current === null && env.result.meshes.unreadable.some((u) => u.file === pointer) && env.warnings.some((w) => w.code === "MESH_REGISTRY_UNREADABLE" && w.message.includes(pointer)), { meshes: env?.result?.meshes, warnings: env?.warnings });
}
{
  const { home, run } = sandbox();
  // Cotal never writes an empty pointer: `use` writes a name and clearing removes the file.
  const pointer = join(home, ".cotal-home", "current-mesh");
  mkdirSync(join(home, ".cotal-home"), { recursive: true });
  writeFileSync(pointer, "");
  const json = run(["status", "--space", "nosuch", "--json"]);
  const env = json.envelope;
  check("an empty current-mesh pointer is named, and the run is partial", json.status === 4 && env?.outcome === "partial" && env.warnings.some((w) => w.code === "MESH_REGISTRY_UNREADABLE" && w.message.includes(pointer) && /is empty/.test(w.message)), { status: json.status, warnings: env?.warnings });
}
{
  const { home, run } = sandbox();
  // A path that exists and is not a directory, so the registry cannot be listed on every platform.
  const registry = join(home, ".cotal-home", "meshes");
  mkdirSync(join(home, ".cotal-home"), { recursive: true });
  writeFileSync(registry, "");
  const json = run(["status", "--json"]);
  const env = json.envelope;
  check("an unreadable registry directory is partial with exit 4, not unknown", json.status === 4 && env?.outcome === "partial" && env.result !== null, shown(json));
  check("the registry is named and the selection is unresolved by it", env?.result?.meshes.unreadable.some((u) => u.file === registry) === true && env.result.selected.resolved === false && env.result.selected.code === "registry-unreadable" && env.warnings.some((w) => w.code === "MESH_REGISTRY_UNREADABLE" && w.message.includes(registry)), { meshes: env?.result?.meshes, selected: env?.result?.selected, warnings: env?.warnings });
}
{
  const { home, run } = sandbox();
  const add = run(["meshes", "add", "alpha", "--server", `nats://127.0.0.1:${await freePort()}`, "--mode", "open", "--root", home, "--force"]);
  check("control: alpha is registered", add.status === 0, shown(add));
  const clean = run(["status", "--space", "alpha", "--json"]);
  check("control: with every registry file readable the run is complete", clean.status === 0 && clean.envelope?.completeness === "complete", shown(clean));
  const record = join(home, ".cotal-home", "meshes", "space.dead.json");
  writeFileSync(record, "{not json");
  const json = run(["status", "--space", "alpha", "--json"]);
  const env = json.envelope;
  check("a registry record that will not parse is partial with exit 4, not unknown", json.status === 4 && env?.outcome === "partial" && env.result !== null, shown(json));
  check("the record is named and the readable records are still listed", env?.result?.meshes.unreadable.some((u) => u.file === record) === true && env.result.meshes.items.some((m) => m.space === "alpha") && env.warnings.some((w) => w.code === "MESH_REGISTRY_UNREADABLE" && w.message.includes(record)), { meshes: env?.result?.meshes, warnings: env?.warnings });
  check("the selection is unresolved by the unreadable record", env?.result?.selected.resolved === false && env.result.selected.code === "registry-unreadable", env?.result?.selected);
  const plain = run(["status", "--space", "alpha", "--plain", "--verbose"]);
  check("the report names the record under the recorded meshes", plain.status === 4 && /unreadable: .*space\.dead\.json does not parse/.test(plain.stdout.split("\nRecorded Meshes\n")[1]?.split("\nSelected Mesh\n")[0] ?? ""), shown(plain));
}

// ── a folder this account cannot read is the one gap, named with its chmod ───────────────────────
if (process.platform !== "win32" && process.getuid?.() !== 0) {
  const { home } = sandbox();
  // No `.cotal` above it, so the folder is its own root, as a fresh project folder is.
  const outside = mkdtempSync(join(tmpdir(), "cotal-status-unreadable-"));
  roots.push(outside);
  const folder = join(outside, "z");
  mkdirSync(folder, { mode: 0o700 });
  const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal-home"), COTAL_SKIP_CONNECTOR_SEED: "1" };
  // The shell enters the folder before its mode drops, as it would for an operator already in it.
  const r = spawnSync("/bin/sh", ["-c", 'cd "$0" && chmod 000 . && exec "$@"', folder, process.execPath, BIN, "status", "--json"], { env, encoding: "utf8", timeout: 120_000 });
  chmodSync(folder, 0o700);
  const envelope = (r.stdout ?? "").startsWith("{") ? (JSON.parse(r.stdout) as Envelope) : undefined;
  const shownR = { status: r.status, stdout: (r.stdout ?? "").slice(0, 900), stderr: (r.stderr ?? "").slice(0, 600) };
  check("status in a folder this account cannot read is partial, exit 4, with a warning naming the folder",
    r.status === 4 && envelope?.outcome === "partial" && envelope.warnings.some((w) => w.code === "FOLDER_UNREADABLE" && w.message === `this folder ${folder} cannot be read by this account (EACCES), so nothing in it was read`), shownR);
  check("…and no other warning about a part of that folder, such as an auth.json it does not hold",
    envelope?.warnings.every((w) => !/^(AUTH_UNREADABLE|PERSONAS_UNREADABLE|FRESH_BOOT_RECORD_UNAVAILABLE|ADDITIVE_ATTEMPT_UNAVAILABLE|MAINTENANCE_JOURNAL_UNREADABLE)$/.test(w.code)) === true && !(envelope?.result?.hints ?? []).some((h) => h.includes("auth.json")), envelope?.warnings);
  check("…and its Next is the chmod that makes it readable", (envelope?.result?.hints ?? []).includes(`make it readable by you, for example with chmod u+rx ${folder}`), envelope?.result?.hints);
}

// ── usage ────────────────────────────────────────────────────────────────────────────────────────
{
  const { run } = sandbox();
  for (const args of [["--components", "--json"], ["--components", "--plain", "--json"], ["--components", "--all", "--json"], ["--plain", "--json"]]) {
    const r = run(["status", ...args]);
    check(`status ${args.join(" ")} is one USAGE_INVALID envelope, exit 1`, r.status === 1 && r.envelope?.error?.code === "USAGE_INVALID", shown(r));
  }
  const plainOnly = run(["status", "--components", "--plain"]);
  check("status --components --plain is refused before any probe, exit 1", plainOnly.status === 1 && plainOnly.stdout === "" && /--components checks the selected mesh/.test(plainOnly.stderr), shown(plainOnly));
  const all = run(["status", "--components", "--all"]);
  check("status --components --all is refused before any probe, exit 1", all.status === 1 && all.stdout === "" && /--components checks the selected mesh/.test(all.stderr), shown(all));
}

// ── a store write failure the running local broker logged is shown with its cause and file ───────
{
  const { home, run } = sandbox();
  const server = ["--server", `nats://127.0.0.1:${await freePort()}`];
  const none = run(["status", ...server, "--json"]);
  check("control: with no broker recorded here, the store is not checked", none.envelope?.result?.store?.state === "not-checked", shown(none));
  // A legacy root's broker: its pidfile names a live process, and its log holds an earlier broker's
  // error, one logged before this broker's start under the same process ID, then this broker's own.
  const pid = process.pid, stamp = "2026/10/23 19:38:44.773287";
  writeFileSync(join(home, ".cotal", "nats.pid"), `${pid}\n`, { mode: 0o600 });
  const log = join(home, ".cotal", "nats.log");
  writeFileSync(log, [
    `[1] ${stamp} [ERR] Filestore [CHAT_s] Critical write error: write /old/msgs/1.blk: file too large`,
    `[${pid}] ${stamp} [ERR] Filestore [CHAT_s] Critical write error: write /reused/msgs/1.blk: file too large`,
    `[${pid}] ${stamp} [INF] Starting nats-server`,
    "",
  ].join("\n"), { mode: 0o600 });
  const started = run(["status", ...server, "--json"]);
  check("an error from another broker, or from before this broker started, is not reported", started.envelope?.result?.store?.state === "none-recorded", shown(started));
  appendFileSync(log, `[${pid}] ${stamp} [ERR] Filestore [CHAT_s] Critical write error: write /store/msgs/1.blk: no space left on device\n`);
  const failed = run(["status", ...server, "--json"]);
  const store = failed.envelope?.result?.store;
  check("status --json names this broker's store write failure with its time, cause and file", store?.state === "write-failed" && store.at === "2026/10/23 19:38:44" && store.cause === "no space left on device" && store.path === "/store/msgs/1.blk", shown(failed));
  const plain = run(["status", ...server, "--plain"]);
  check("the report shows a Store row and leads Next with down, after freeing space on the disk for a full one", /Store: +write failed at 2026\/10\/23 19:38:44: no space left on device - \/store\/msgs\/1\.blk/.test(plain.stdout) && /cotal down +First free space on the disk that holds \S+; then .*`cotal up` starts the broker again with the history it kept/.test(plain.stdout), plain.stdout);
  // The repair follows the cause: a permission is given back, not disk space freed.
  appendFileSync(log, `[${pid}] ${stamp} [ERR] Filestore [CHAT_s] Critical write error: open /store/msgs/2.blk: permission denied\n`);
  const denied = run(["status", ...server, "--plain"]);
  check("for a permission denied, Next makes the store writable by this account again and says nothing of disk space", /cotal down +First make \S+ writable by this account again/.test(denied.stdout) && !/Free space|free space/.test(denied.stdout), denied.stdout);
}

// ── damage the running local broker found in a stored file is shown in its own words ────────────
{
  const { home, run } = sandbox();
  const server = ["--server", `nats://127.0.0.1:${await freePort()}`];
  const pid = process.pid, stamp = "2026/10/25 01:24:11.149803";
  writeFileSync(join(home, ".cotal", "nats.pid"), `${pid}\n`, { mode: 0o600 });
  const log = join(home, ".cotal", "nats.log");
  // The three warnings as nats-server 2.14 logs them; the first is from before this broker started.
  const block = "Filestore [CHAT_s] indexCacheBuf corrupt record state in .cotal/nats/jetstream/A/streams/CHAT_s/msgs/1.blk: dlen 2147483193 slen 65451 index 2592 rl 2147483215 lbuf 5184";
  const rolledBack = "JetStream consumer 'A > CHAT_s > fanout' delivered sequence 12 past last stream sequence of 8";
  writeFileSync(log, [`[${pid}] ${stamp} [WRN] ${block}`, `[${pid}] ${stamp} [INF] Starting nats-server`, ""].join("\n"), { mode: 0o600 });
  const before = run(["status", ...server, "--json"]);
  check("damage logged before this broker started is not reported", before.envelope?.result?.store?.state === "none-recorded", shown(before));
  appendFileSync(log, `[${pid}] ${stamp} [WRN]   Stream metafile ".cotal/nats/jetstream/A/streams/CHAT_s/meta.inf": checksums do not match "5e352183bb879de0" vs "523cc3d3cb0c740e"\n[${pid}] ${stamp} [WRN] ${rolledBack}\n`);
  const damaged = run(["status", ...server, "--json"]);
  const store = damaged.envelope?.result?.store as { state?: string; at?: string; warning?: string } | undefined;
  check("status --json names the newest damage this broker logged, in its words, with its time", damaged.status === 0 && store?.state === "damaged" && store.at === "2026/10/25 01:24:11" && store.warning === rolledBack, shown(damaged));
  appendFileSync(log, `[${pid}] ${stamp} [WRN] ${block}\n`);
  const plain = run(["status", ...server, "--plain"]);
  check("the report shows a Store row quoting the corrupt block", /Store: +damage logged at 2026\/10\/25 01:24:11: /.test(plain.stdout) && plain.stdout.includes(block), plain.stdout);
  appendFileSync(log, `[${pid}] ${stamp} [ERR] Filestore [CHAT_s] Critical write error: write /store/msgs/1.blk: no space left on device\n[${pid}] ${stamp} [WRN] ${block}\n`);
  check("a store write failure is named before damage logged after it", run(["status", ...server, "--json"]).envelope?.result?.store?.state === "write-failed");
}

// ── a nats-server on PATH below the broker floor ─────────────────────────────────────────────────
if (process.platform !== "win32") {
  const { home, run } = sandbox();
  const bin = join(home, "old-bin"), old = join(bin, "nats-server"), project = join(home, "project");
  mkdirSync(bin);
  mkdirSync(project);
  writeFileSync(old, '#!/bin/sh\n[ "$1" = --version ] && { echo "nats-server: v2.2.0"; exit 0; }\nexit 1\n', { mode: 0o755 });
  const onPath = { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
  const named = /the nats-server on PATH at \S+\/old-bin\/nats-server reports version 2\.2\.0, and this stack needs nats-server 2\.12 or newer/;
  const json = run(["status", "--space", "nosuch", "--json"], onPath);
  const machine = json.envelope?.result?.machine;
  check("status names the old nats-server on PATH, its version and why up refuses it", json.status === 0 && machine?.nats === "path" && machine.natsServer?.path === old && machine.natsServer.version === "2.2.0" && named.test(machine.natsProblem ?? ""), machine);
  const plain = run(["status", "--space", "nosuch", "--plain"], onPath);
  check("the Broker executable row says so", new RegExp(`^ {2}Broker executable: +${named.source}$`, "m").test(plain.stdout), shown(plain));
  const port = await freePort();
  const created = run(["space", "create", "gate", "--root", project, "--json"], onPath);
  check("space create prepares the project", created.status === 0, shown(created));
  const up = spawnSync(process.execPath, [BIN, "up", "--space", "gate", "--server", `nats://127.0.0.1:${port}`, "--json"], { cwd: project, env: { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal-home"), COTAL_SKIP_CONNECTOR_SEED: "1", ...onPath }, encoding: "utf8", timeout: 120_000 });
  const refusal = JSON.parse(up.stdout || "{}") as { outcome?: string; error?: { code?: string; message?: string; remedy?: string } };
  check("up refuses it DEPENDENCY_UNAVAILABLE, exit 2, naming its path and version", up.status === 2 && refusal.outcome === "refused" && refusal.error?.code === "DEPENDENCY_UNAVAILABLE" && named.test(refusal.error.message ?? "") && /take it off PATH so cotal uses its bundled nats-server/.test(refusal.error.remedy ?? ""), { status: up.status, error: up.error?.message, stdout: (up.stdout ?? "").slice(0, 900), stderr: (up.stderr ?? "").slice(0, 600) });
  check("and no broker answers at its address", !(await new Promise<boolean>((done) => { const socket = connect(port, "127.0.0.1"); socket.once("connect", () => { socket.destroy(); done(true); }); socket.once("error", () => done(false)); })), port);
}

// ── This machine shows what is set up and what needs attention ───────────────────────────────────
{
  const { home, run } = sandbox();
  const bin = join(home, "apps");
  mkdirSync(bin);
  writeFileSync(join(bin, "aa-bin"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // `bb-bin` is deliberately absent, so bb is an application this machine has not set up.
  const connector = (name: string, requires: string[]) => ({
    pkg: `@rig/${name}`, version: VERSION, spec: `@rig/${name}@${VERSION}`,
    provides: [{ kind: "connector", name }], commands: [],
    // No setup provider, so no package is imported for its rows.
    connectors: [{ name, requires, eventPlane: false, setup: null }],
  });
  const manifest = join(home, ".config", "cotal", "extensions");
  mkdirSync(manifest, { recursive: true });
  writeFileSync(join(manifest, "extensions.json"), JSON.stringify({ extensions: [
    connector("aa", ["aa-bin"]), connector("bb", ["bb-bin"]),
    { pkg: "@rig/one", version: VERSION, spec: `@rig/one@${VERSION}`, provides: [{ kind: "runtime", name: "one" }], commands: [] },
    { pkg: "@rig/two", version: VERSION, spec: `@rig/two@${VERSION}`, provides: [{ kind: "runtime", name: "two" }], commands: [] },
  ] }));
  const onPath = { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
  const plain = run(["status", "--space", "nosuch", "--plain"], onPath);
  const machine = plain.stdout.split("\n\n")[0] ?? "";
  check("the applications line names what is set up and counts the rest behind cotal setup",
    /^ {2}Agent applications: +aa - 1 more with `cotal setup`$/m.test(plain.stdout), shown(plain));
  check("no row is printed per known application",
    !/^ {2}aa: /m.test(plain.stdout) && !/^ {2}bb: /m.test(plain.stdout) && !/not on PATH/.test(plain.stdout), machine);
  check("the extensions line is one count at the version they share",
    new RegExp(`^ {2}Extensions: +4 extensions at ${VERSION.replaceAll(".", "\\.")}$`, "m").test(plain.stdout), machine);
  check("a healthy broker executable and an absent optional dashboard print no row",
    !/Broker executable/.test(plain.stdout) && !/Dashboard/.test(plain.stdout), machine);
  const json = run(["status", "--space", "nosuch", "--json"], onPath);
  const read = json.envelope?.result?.machine as { connectors?: { name: string; missing: string[] }[] } | undefined;
  check("--json still carries every known application and its missing requirements",
    json.status === 0 && (read?.connectors ?? []).map((c) => `${c.name}:${c.missing.join()}`).join(" ") === "aa: bb:bb-bin" &&
      (json.envelope?.result?.extensions as { items?: unknown[] } | undefined)?.items?.length === 4, read);
  const wide = run(["status", "--space", "nosuch", "--plain", "--wide"], onPath);
  check("--wide prints the row per application and every extension label again",
    /^ {2}aa: +available on PATH$/m.test(wide.stdout) && /^ {2}bb: +bb-bin not on PATH$/m.test(wide.stdout) &&
      /^ {2}Extensions: +aa v/m.test(wide.stdout) && /Broker executable/.test(wide.stdout) && /Dashboard/.test(wide.stdout), shown(wide));
  const all = run(["status", "--space", "nosuch", "--plain", "--all"], onPath);
  check("--all reports the same rows in full", /^ {2}aa: +available on PATH$/m.test(all.stdout) && /Broker executable/.test(all.stdout), shown(all));
  // A pin an upgrade did not carry is the one thing named, against the version the rest share.
  writeFileSync(join(manifest, "extensions.json"), JSON.stringify({ extensions: [
    connector("aa", ["aa-bin"]),
    { pkg: "@rig/one", version: VERSION, spec: `@rig/one@${VERSION}`, provides: [{ kind: "runtime", name: "one" }], commands: [] },
    { pkg: "@rig/old", version: "0.0.1", spec: "@rig/old@0.0.1", provides: [{ kind: "runtime", name: "old" }], commands: [] },
  ] }));
  const skewed = run(["status", "--space", "nosuch", "--plain"], onPath);
  check("an extension at another version is the only one named",
    new RegExp(`^ {2}Extensions: +3 extensions at ${VERSION.replaceAll(".", "\\.")} - old v0\\.0\\.1$`, "m").test(skewed.stdout), shown(skewed));
}

// ── a folder's space is the target here only while it runs ───────────────────────────────────────
// Both arms, in the folder that holds the space: a running registration is the target and says the
// selection applies outside it; a prepared or stopped one is not, and the report names the selection
// with what this folder holds under it.
{
  const greeter = spawn(process.execPath, ["-e", `const s = require("node:net").createServer((c) => { c.on("error", () => {}); c.end('INFO {"server_id":"folder","version":"2.12.12","proto":1,"max_payload":1048576}\\r\\n'); }); s.listen(0, "127.0.0.1", () => console.log(s.address().port));`], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const [answered] = (await once(greeter.stdout!, "data")) as [Buffer];
    const live = `nats://127.0.0.1:${answered.toString().trim()}`;
    const closed = `nats://127.0.0.1:${await freePort()}`;
    /** A sandbox whose working folder holds `held` and whose selection is another space. */
    const folderRig = async (hold: (project: string, run: ReturnType<typeof sandbox>["run"]) => void) => {
      const { home, run } = sandbox();
      const project = join(home, "project"), elsewhere = join(home, "elsewhere");
      mkdirSync(join(project, ".cotal"), { recursive: true });
      mkdirSync(elsewhere);
      hold(project, run);
      check("rig: the selection is registered elsewhere", run(["meshes", "add", "sel", "--server", closed, "--mode", "open", "--root", elsewhere, "--force"]).status === 0);
      check("rig: it is selected", run(["use", "sel"]).status === 0);
      return { run: (args: string[]) => run(args, {}, project) };
    };

    const running = await folderRig((project, run) => {
      check("rig: this folder's space is registered at a broker that answers",
        run(["meshes", "add", "held", "--server", live, "--mode", "open", "--root", project, "--force"]).status === 0);
    });
    const runningText = running.run(["status", "--plain"]);
    const runningJson = running.run(["status", "--json"]);
    check("a running folder space is the target, and the heading says the selection applies outside it",
      runningJson.envelope?.target.space === "held" && runningJson.envelope.result?.meshes.current === "sel" &&
        /^Mesh: held\n {2}this folder's space; the selected space "sel" applies outside it$/m.test(runningText.stdout), shown(runningText));

    const stopped = await folderRig((project, run) => {
      check("rig: this folder's space is registered at a broker that does not answer",
        run(["meshes", "add", "held", "--server", closed, "--mode", "open", "--root", project, "--force"]).status === 0);
    });
    const stoppedText = stopped.run(["status", "--plain"]);
    const stoppedJson = stopped.run(["status", "--json"]);
    check("a stopped folder space is not the target: the selection is, with what this folder holds under it",
      stoppedJson.envelope?.target.space === "sel" &&
        /^Mesh: sel\n {2}this folder holds the stopped space "held"; restart it with `cotal up`$/m.test(stoppedText.stdout) &&
        !/this folder's space/.test(stoppedText.stdout), shown(stoppedText));

    const prepared = await folderRig((project, run) => {
      const created = run(["space", "create", "held", "--root", project]);
      check("rig: this folder holds a prepared space", created.status === 0, shown(created));
    });
    const preparedText = prepared.run(["status", "--plain"]);
    const preparedJson = prepared.run(["status", "--json"]);
    check("a prepared folder space is not the target either, and its up is named under the selection",
      preparedJson.envelope?.target.space === "sel" && preparedJson.envelope.result?.meshes.folder === null &&
        /^Mesh: sel\n {2}this folder holds the prepared space "held"; start it with `cotal up`$/m.test(preparedText.stdout), shown(preparedText));
  } finally {
    if (greeter.exitCode === null && greeter.signalCode === null) {
      const exited = once(greeter, "exit");
      greeter.kill();
      await exited;
    }
  }
}

// ── a stopped root whose broker kept a store names the reset that reaches it ─────────────────────
// Next named the legacy `clean store --force` for a stale store. `reset store <space>` replaces it
// where it selects this root's store; a root whose down removed that registration has no reset
// target, and its reset refusal names clean, so status keeps naming clean there.
{
  const { home, run } = sandbox();
  const parent = mkdtempSync(join(tmpdir(), "cotal-status-stale-"));
  roots.push(parent);
  const [registered, unregistered] = ["stalereg", "staleunreg"].map((name) => join(parent, name));
  for (const root of [registered, unregistered]) mkdirSync(join(root, ".cotal", "nats"), { recursive: true });
  const previousHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = join(home, ".cotal-home");
  try { recordMesh({ space: "stalereg", server: `nats://127.0.0.1:${await freePort()}`, root: registered, mode: "open", origin: "up", ts: new Date().toISOString() }); }
  finally { if (previousHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = previousHome; }
  const staleHints = (root: string) => (run(["status", "--json"], {}, root).envelope?.result?.hints ?? []).filter((hint) => hint.startsWith("if the stored JetStream state is stale:"));
  const reg = staleHints(registered);
  check("a registered stopped root names reset store with the space registered there", reg.length === 1 && / reset store stalereg`, then `up` with your usual flags$/.test(reg[0]!) && !reg[0]!.includes("clean"), reg);
  const preview = run(["reset", "store", "stalereg", "--dry-run", "--json"], {}, registered);
  check("…and that reset reaches the store as printed", preview.status === 0 && preview.envelope?.outcome === "ok", shown(preview));
  const unreg = staleHints(unregistered);
  check("a root with no registration a reset selects keeps clean store --force", unreg.length === 1 && / clean store --force`, then `up` with your usual flags \(`clean all` also resets identity\)$/.test(unreg[0]!), unreg);
  const refused = run(["reset", "store", "staleunreg", "--dry-run", "--json"], {}, unregistered);
  check("…because reset refuses that root TARGET_NOT_FOUND", refused.status === 2 && refused.envelope?.error?.code === "TARGET_NOT_FOUND", shown(refused));
}


}

// Display copies never expose stored broker credentials, including legacy component facts.
{
  const { home, run } = sandbox();
  const previousHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = join(home, ".cotal-home");
  const marker = "unusable-status-display-marker";
  try {
    const port = await freePort();
    const display = `nats://127.0.0.1:${port}`;
    const cases = [
      { name: "ordinary", server: display, display },
      { name: "password", server: `nats://user:${marker}@127.0.0.1:${port}?token=${marker}#${marker}`, display },
      { name: "bare", server: `user:${marker}@127.0.0.1:${port}?token=${marker}#${marker}`, display: `127.0.0.1:${port}` },
      { name: "list", server: `${display},nats://user:${marker}@127.0.0.1:${port}?token=${marker}`, display: `${display},${display}` },
      { name: "invalid", server: `https://user:${marker}@127.0.0.1:${port}`, display: null },
    ];
    for (const item of cases) {
      brokerDisplayCases++;
      const space = `status-display-${item.name}`;
      recordMesh({ space, server: item.server, root: home, mode: "open", origin: "manual", ts: new Date().toISOString() });
      const json = run(["status", "--space", space, "--json"]);
      const result = json.envelope?.result;
      const recorded = result?.meshes.items.find(mesh => mesh.space === space);
      if (item.display !== null) {
        check(`status redacts recorded broker address for ${item.name}`, json.status === 0 && recorded?.server === item.display, { status: json.status, matches: recorded?.server === item.display });
        check(`status redacts selected broker address for ${item.name}`, result?.selected.resolved === true && result.selected.server === item.display, { matches: result?.selected.server === item.display });
      } else {
        check("status reports an invalid stored address as unknown", json.status === 4 && json.envelope?.outcome === "partial" && recorded?.server === null && result?.selected.server === null && json.envelope.warnings.some(w => w.code === "BROKER_ADDRESS_INVALID"), { status: json.status, warnings: json.envelope?.warnings });
      }
      check(`status JSON omits all broker URL markers for ${item.name}`, !json.stdout.includes(marker) && !json.stderr.includes(marker), { status: json.status });
      for (const format of ["--plain", undefined]) {
        const read = run(["status", "--space", space, ...(format ? [format] : [])], { NO_COLOR: "1" });
        const text = read.stdout + read.stderr;
        check(`status ${format ?? "human"} redacts broker address for ${item.name}`, read.status === (item.display === null ? 4 : 0) && !text.includes(marker) && text.includes(item.display ?? "unavailable"), { status: read.status, containsMarker: text.includes(marker) });
      }
      const components = run(["status", "--space", space, "--components"], { NO_COLOR: "1" });
      const facts = components.stdout.split("Component Health")[1] ?? "";
      check(`status component facts omit broker secrets for ${item.name}`, components.status !== null && [1, 2, 3].includes(components.status) && !facts.includes(marker) && facts.includes(item.display === null ? "registered address unavailable" : `registered ${item.display}`), { status: components.status, containsMarker: facts.includes(marker) });
      check(`status does not rewrite saved dial input for ${item.name}`, findMesh(space)?.server === item.server);
    }
  } finally {
    if (previousHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = previousHome;
  }
}

// ── a folder holding a space this machine registers for another folder ───────────────────────────
// A copy of a legacy project, the folder a later `up` took the name over from, and one moved away
// from its recorded path all hold the space's records with no registration of their own. Status read
// them as a folder whose own stack was merely stopped and offered `cotal up` here, which refuses the
// name or takes it over. It now names the registered folder and the step that reaches it, under the
// space the folder's records name.
{
  const { home, run } = sandbox();
  const key = Buffer.from("st01").toString("hex");
  mkdirSync(join(home, ".cotal", "auth"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".cotal", "auth", "server.conf"), "# Generated by `cotal up` - do not edit by hand.\nhost: 127.0.0.1\nport: 24716\n", { mode: 0o600 });
  writeFileSync(join(home, ".cotal", "auth", `account.${key}.json`), JSON.stringify({ space: "st01", account: { pub: "P", jwt: "J", signingSeed: "S", signingPub: "SP" } }) + "\n", { mode: 0o600 });
  const holder = mkdtempSync(join(tmpdir(), "cotal-status-holder-"));
  roots.push(holder);
  const previousHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = join(home, ".cotal-home");
  try { recordMesh({ space: "st01", server: "nats://127.0.0.1:24717", root: holder, mode: "auth", origin: "up", ts: new Date().toISOString() }); }
  finally { if (previousHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = previousHome; }
  const json = run(["status", "--json"]);
  const selected = json.envelope?.result?.selected;
  // It reports under st01, as the reads there refuse under it, and says what the folder holds.
  check("status in a folder whose space is registered elsewhere names that folder, not this one's own cotal up",
    json.envelope?.target?.space === "st01" && (selected as { message?: string } | undefined)?.message === `this folder holds the records of "st01", which is registered for ${holder}`, shown(json));
  check("its Next is the step that reaches the stack there, and offers no plain cotal up here",
    (json.envelope?.result?.hints ?? []).includes(`use the stack from ${holder}, where "st01" is registered`) && !(json.envelope?.result?.hints ?? []).some((hint) => hint === `start it again with \`cotal up\` in ${home}`), json.envelope?.result?.hints);
}

if (brokerDisplayOnly) check("broker display profile reaches all five fixtures", brokerDisplayCases === 5);
finish();
