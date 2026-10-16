/**
 * The read commands ported to the structured output contract, driven through the built binary in a
 * fresh sandbox per case: `cotal runtimes` as a report, plain text and one envelope, and partial
 * when an installed runtime provider cannot load; `ps` and `models` refused before any request,
 * under the code for why, when no mesh can be resolved; and the usage refusals `ps` declares.
 * Broker-free. The mesh paths are in `smoke:cli-on-instance`, `smoke:spawn-detach:live` and
 * `smoke:ps-user-mode`.
 *
 * Run: pnpm smoke:read-envelopes
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

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

type Envelope = {
  outcome: string; completeness: string; target: unknown; command: string;
  result: { items: { name: string; state: string; reachable: boolean | null; error: string | null }[] } | null;
  warnings: { code: string; target: unknown }[]; error?: { code: string; message: string; remedy?: string };
};

/** A sandboxed home, with an optional extensions manifest. `viaLink` reaches it through a symlink,
 *  as a home on a linked volume is, so the command's cwd is canonical and its HOME is not. */
function sandbox(manifest?: unknown, viaLink = false) {
  const real = mkdtempSync(join(tmpdir(), "cotal-read-envelopes-"));
  roots.push(real);
  const home = viaLink ? `${real}-link` : real;
  if (viaLink) {
    symlinkSync(real, home, "junction");
    roots.push(home);
  }
  const xdg = join(home, ".config");
  if (manifest !== undefined) {
    mkdirSync(join(xdg, "cotal", "extensions"), { recursive: true });
    writeFileSync(join(xdg, "cotal", "extensions", "extensions.json"), JSON.stringify(manifest));
  }
  return (args: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      cwd: home,
      env: { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", ...extraEnv },
      encoding: "utf8",
      timeout: 120_000,
    });
    const stdout = r.stdout ?? "";
    let envelope: Envelope | undefined;
    const lines = stdout.split("\n").filter(Boolean);
    if (lines.length === 1 && lines[0]!.startsWith("{")) envelope = JSON.parse(lines[0]!) as Envelope;
    return { status: r.status, stdout, stderr: r.stderr ?? "", envelope };
  };
}
const shown = (r: { status: number | null; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 600), stderr: r.stderr.slice(0, 600) });
const ansi = /\x1b\[/;

// ── runtimes: three presentations of one local read ──────────────────────────────────────────────
{
  const run = sandbox();
  const json = run(["runtimes", "--json"]);
  const names = json.envelope?.result?.items.map((row) => `${row.name}:${row.state}`);
  check("runtimes --json is one complete envelope with no target", json.status === 0 && json.envelope?.outcome === "ok" && json.envelope.completeness === "complete" && json.envelope.target === null, shown(json));
  check("runtimes --json lists pty built in and each official runtime as not installed", JSON.stringify(names) === JSON.stringify(["pty:built-in", "orca:not-installed", "tmux:not-installed", "cmux:not-installed", "herdr:not-installed"]), names);
  const rich = run(["runtimes"], { FORCE_COLOR: "1" });
  const richText = rich.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  check("runtimes draws a colored table with its state words", rich.status === 0 && ansi.test(rich.stdout) && /RUNTIME\s+STATE\s+PACKAGE/.test(richText) && /tmux\s+not installed\s+@cotal-ai\/tmux/.test(richText) && /cotal ext add <package>/.test(richText), shown(rich));
  const plain = run(["runtimes", "--plain"], { FORCE_COLOR: "1" });
  check("runtimes --plain writes the same words with no ANSI", plain.status === 0 && !ansi.test(plain.stdout) && plain.stdout === richText, shown(plain));
  check("no report line ends in padding", plain.stdout.split("\n").every((line) => !line.endsWith(" ")), plain.stdout);
  const both = run(["runtimes", "--json", "--plain"]);
  check("runtimes --json --plain is one USAGE_INVALID envelope, exit 1", both.status === 1 && both.envelope?.error?.code === "USAGE_INVALID", shown(both));
}

// ── runtimes: an installed provider that cannot load makes the read partial ──────────────────────
{
  const run = sandbox({ extensions: [{ pkg: "@example/broken-runtime", version: "1.0.0", spec: "@example/broken-runtime@1.0.0", provides: [{ kind: "runtime", name: "broken" }], commands: [] }] });
  const json = run(["runtimes", "--json"]);
  const broken = json.envelope?.result?.items.find((row) => row.name === "broken");
  check("a provider that cannot load makes runtimes --json partial, exit 4", json.status === 4 && json.envelope?.outcome === "partial" && json.envelope.completeness === "partial" && json.envelope.error?.code === "OPERATION_PARTIAL", shown(json));
  check("the provider is listed as installed with its load error, never dropped", broken?.state === "installed" && broken.reachable === null && /not installed at/.test(broken.error ?? ""), broken);
  check("a RUNTIME_LOAD_FAILED warning names it", json.envelope?.warnings.some((w) => w.code === "RUNTIME_LOAD_FAILED" && JSON.stringify(w.target) === JSON.stringify({ runtime: "broken" })) === true, json.envelope?.warnings);
  const human = run(["runtimes"]);
  check("the human report exits 4 and names the failure on stderr", human.status === 4 && /broken\s+installed · load failed/.test(human.stdout) && /1 installed runtime provider could not be loaded/.test(human.stderr), shown(human));
}

// ── ps and models: no mesh to read is refused before any request ─────────────────────────────────
{
  const run = sandbox();
  for (const command of ["ps", "models"]) {
    const json = run([command, "--json"]);
    check(`${command} --json with no mesh is one TARGET_NOT_FOUND envelope, exit 2`,
      json.status === 2 && json.envelope?.outcome === "refused" && json.envelope.command === command && json.envelope.error?.code === "TARGET_NOT_FOUND" && /no mesh running/.test(json.envelope.error.message), shown(json));
    check(`${command} --json with no mesh gives the remedy apart from the message`,
      json.envelope?.error?.message === "no mesh running" && json.envelope.error.remedy === "run `cotal up` in a project, or pass `--server`", json.envelope?.error);
    const human = run([command]);
    check(`${command} with no mesh exits 2 with the sentence on stderr and nothing on stdout`, human.status === 2 && human.stdout === "" && /no mesh running/.test(human.stderr), shown(human));
  }
  const named = run(["models", "--json", "--space", "nope"]);
  check("models --json --space <unknown> names the space it could not find", named.status === 2 && named.envelope?.error?.code === "TARGET_NOT_FOUND" && /no mesh named "nope"/.test(named.envelope.error.message), shown(named));
  check("an unknown --space refusal names where to look in its remedy", named.envelope?.error?.remedy === "see `cotal meshes`", named.envelope?.error);
}

// ── ps and models: a home reached through a symlink is still no project ──────────────────────────
{
  const run = sandbox(undefined, true);
  for (const command of ["ps", "models"]) {
    const json = run([command, "--json"]);
    check(`${command} --json from a home reached through a symlink is TARGET_NOT_FOUND, not a mesh in that home`,
      json.status === 2 && json.envelope?.error?.code === "TARGET_NOT_FOUND" && /no mesh running/.test(json.envelope.error.message), shown(json));
  }
}

// ── ps: its usage refusals are envelopes too ──────────────────────────────────────────────────────
{
  const run = sandbox();
  const cases: [string, string[]][] = [
    ["--wide --json", ["ps", "--wide", "--json"]],
    ["--slots --wide", ["ps", "--slots", "--wide", "--json"]],
    ["--json --plain", ["ps", "--json", "--plain"]],
    ["an empty --on", ["ps", "--on", "", "--json"]],
    ["a malformed --on", ["ps", "--on", "4ik6rb0e", "--json"]],
  ];
  for (const [what, argv] of cases) {
    const r = run(argv);
    check(`ps ${what} is one USAGE_INVALID envelope, exit 1, before any mesh is resolved`, r.status === 1 && r.envelope?.error?.code === "USAGE_INVALID" && !/no mesh running/.test(r.stderr), shown(r));
  }
}

finish();
