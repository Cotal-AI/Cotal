/**
 * Bare `cotal status` on the structured output contract, driven through the built binary in a fresh
 * sandbox per case: one envelope whose result the report is drawn from, the agreed section order with
 * the hints last and no roster, only the selected registration checked unless `--all` asks for each,
 * a part it cannot read named on its row and reported partial (exit 4) rather than complete, and the
 * usage refusals. Broker-free: every registration points at a closed port. The live rows are in
 * `smoke:delivery-responder-visibility`, `smoke:component-health`, `smoke:ps-user-mode` and
 * `smoke:up-tls-routes`.
 *
 * Run: pnpm smoke:status-report
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite, freePort } from "@cotal-ai/smoke-kit";
import { acquireMaintenanceLock, beginMaintenanceCut, findMesh, recordMesh, releaseMaintenanceLock, renderReport, writeMaintenanceResumeDocument } from "@cotal-ai/workspace";
import { statusView } from "../src/commands/status.js";
import { restoreNextStep } from "../src/lib/restore.js";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}
const { check, finish } = createSuite();
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
    machine: { nats: string };
    folder: { auth: { state: string }; personas: { root: string; default: string; error: string | null }; processes: { name: string; state: string }[] | null };
    meshes: { current: string | null; unreadable: { file: string; error: string }[]; items: Mesh[] };
    selected: { resolved: boolean; code?: string; space?: string; server?: string | null; connection?: string };
    maintenance?: { root: string; space: string | null; state: string; attemptId: string | null; next: string | null } | null;
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
  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      cwd: home,
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
    JSON.stringify(titles(plain.stdout)) === JSON.stringify(["This machine", "Brokers", "Selected space", "Next"]),
    titles(plain.stdout),
  );
  check(
    "--verbose adds the detail sections before Next",
    verbose.status === 0 && JSON.stringify(titles(verbose.stdout)) === JSON.stringify(["This machine", "Brokers", "Selected space", "Machine", "Extensions", "This Folder", "Recorded Meshes", "Selected Mesh", "Next"]),
    titles(verbose.stdout),
  );
  check("the report names no roster", !/roster/i.test(plain.stdout) && !/roster/i.test(verbose.stdout), plain.stdout);
  // The NATS row is in the verbose Machine section; the default view says Broker executable.
  check("the NATS row says where nats-server comes from in words", /^ {2}NATS: +(nats-server on PATH|bundled nats-server|missing)$/m.test(verbose.stdout) && ["path", "bundled", "missing"].includes(env?.result?.machine?.nats ?? ""), { nats: env?.result?.machine?.nats, out: verbose.stdout.slice(0, 400) });
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
  const plain = run(["status", "--space", "alpha", "--plain"]);
  check("the report says not checked for the other registration", /beta\s+not checked/.test(plain.stdout), plain.stdout);
  const all = run(["status", "--space", "alpha", "--all", "--json"]);
  check("--all checks every registration", byName(all.envelope).alpha === "unreachable" && byName(all.envelope).beta === "unreachable", byName(all.envelope));
  check("--all is named in the target", all.envelope?.target.scope === "all" && all.envelope.target.space === "alpha", all.envelope?.target);
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
  check("a held restore names its recover command with the full attempt id", new RegExp(`Attempt: +${attempt}`).test(report) && report.includes(`cotal backup recover ${attempt} --dry-run`), report);
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

if (brokerDisplayOnly) check("broker display profile reaches all five fixtures", brokerDisplayCases === 5);
finish();
