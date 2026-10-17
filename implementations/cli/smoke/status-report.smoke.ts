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

type Mesh = { space: string; check: string; current: boolean };
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
    selected: { resolved: boolean; code?: string; space?: string; connection?: string };
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
  check("status draws a colored report", rich.status === 0 && /\x1b\[/.test(rich.stdout), shown(rich));
  check("--plain writes the same words with no ANSI", plain.status === 0 && !/\x1b\[/.test(plain.stdout) && plain.stdout === strip(rich.stdout), shown(plain));
  check(
    "the sections keep the infrastructure order and end with the hints",
    JSON.stringify(titles(plain.stdout)) === JSON.stringify(["Machine", "Extensions", "This Folder", "Recorded Meshes", "Selected Mesh", "Hints"]),
    titles(plain.stdout),
  );
  check("the report names no roster", !/roster/i.test(plain.stdout), plain.stdout);
  check("the NATS row says where nats-server comes from in words", /^ {2}NATS: +(nats-server on PATH|bundled nats-server|missing)$/m.test(plain.stdout) && ["path", "bundled", "missing"].includes(env?.result?.machine?.nats ?? ""), { nats: env?.result?.machine?.nats, out: plain.stdout.slice(0, 400) });
  check("each hint in the result is printed under Hints", (env?.result?.hints ?? []).every((hint) => plain.stdout.split("\nHints\n")[1]?.includes(hint)), { hints: env?.result?.hints, out: plain.stdout });
  check("no report line ends in padding", plain.stdout.split("\n").every((line) => !line.endsWith(" ")), plain.stdout);
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
  const plain = run(["status", "--space", "alpha", "--plain"]);
  check("the report says not checked for the other registration", /beta\s+not checked/.test(plain.stdout), plain.stdout);
  const all = run(["status", "--space", "alpha", "--all", "--json"]);
  check("--all checks every registration", byName(all.envelope).alpha === "unreachable" && byName(all.envelope).beta === "unreachable", byName(all.envelope));
  check("--all is named in the target", all.envelope?.target.scope === "all" && all.envelope.target.space === "alpha", all.envelope?.target);
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
  const plain = run(["status", ...server, "--plain"]);
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
  const plain = run(["status", "--space", "nosuch", "--plain"]);
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
  const plain = run(["status", "--space", "alpha", "--plain"]);
  check("the report names the record under the recorded meshes", plain.status === 4 && /unreadable: .*space\.dead\.json does not parse/.test(plain.stdout.split("\nRecorded Meshes\n")[1]?.split("\nSelected Mesh\n")[0] ?? ""), shown(plain));
}

// ── usage ────────────────────────────────────────────────────────────────────────────────────────
{
  const { run } = sandbox();
  for (const args of [["--components", "--json"], ["--components", "--plain", "--json"], ["--components", "--all", "--json"], ["--plain", "--json"]]) {
    const r = run(["status", ...args]);
    check(`status ${args.join(" ")} is one USAGE_INVALID envelope, exit 1`, r.status === 1 && r.envelope?.error?.code === "USAGE_INVALID", shown(r));
  }
  const all = run(["status", "--components", "--all"]);
  check("status --components --all is refused before any probe, exit 1", all.status === 1 && all.stdout === "" && /--components checks the selected mesh/.test(all.stderr), shown(all));
}

finish();
