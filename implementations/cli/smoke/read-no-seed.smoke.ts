/**
 * A read installs nothing. Each read runs through the built binary in a fresh sandbox with the seed
 * gate live (no `COTAL_SKIP_CONNECTOR_SEED`). From a source checkout the gate refuses to seed, so a
 * read that still reached it would exit 1 with that refusal; a read must run past it and leave the
 * seed store and the extension manifest unwritten. A command that is not a read still meets the
 * gate. A read that would load a built-in installed at another version than the binary's names it
 * with `cotal ext seed` instead of importing it.
 *
 * Run: pnpm smoke:read-no-seed
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}
const VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "bin", "package.json"), "utf8")) as { version: string }).version;
const { check, finish } = createSuite();
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const roots: string[] = [];
process.on("exit", () => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A fresh home whose own `.cotal` stops the root walk, so no project above the temp dir is read. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "cotal-read-no-seed-"));
  roots.push(home);
  mkdirSync(join(home, ".cotal"));
  const xdg = join(home, ".config");
  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      cwd: home,
      env: { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: join(home, ".cotal"), ...extraEnv },
      encoding: "utf8",
      timeout: 120_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { home, xdg, run };
}
const shown = (r: { status: number | null; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 600) });
const GATE = /refusing to reconcile the operator-global seed store/;

// ── Reads run past the seed gate and write nothing ──────────────────────────────────────────────────
{
  const { xdg, run } = sandbox();
  const reads: { args: string[]; exit: number }[] = [
    { args: ["status", "--json"], exit: 0 },
    { args: ["ext", "--json"], exit: 0 },
    { args: ["ext", "list", "--json"], exit: 0 },
    { args: ["ext", "root"], exit: 0 },
    { args: ["runtimes", "--json"], exit: 0 },
    { args: ["docs", "--json"], exit: 0 },
    { args: ["config", "--json"], exit: 0 },
    { args: ["space", "--json"], exit: 0 },
    { args: ["ps", "--json"], exit: 2 },
    { args: ["models", "--json"], exit: 2 },
    { args: ["who", "--json"], exit: 2 },
  ];
  for (const { args, exit } of reads) {
    const r = run(args);
    check(`${args.filter((a) => a !== "--json").join(" ")} is a read: it runs past the seed gate, exit ${exit}`, r.status === exit && !GATE.test(r.stderr) && !/✓ added/.test(r.stderr), shown(r));
  }
  check("the reads wrote no seed store and no extension manifest",
    !existsSync(join(xdg, "cotal", "seed")) && !existsSync(join(xdg, "cotal", "extensions", "extensions.json")),
    { seed: existsSync(join(xdg, "cotal", "seed")), manifest: existsSync(join(xdg, "cotal", "extensions", "extensions.json")) });
  const human = run(["status"], { NO_COLOR: "1" });
  check("status on a fresh machine says no agent application is set up and points at cotal setup",
    human.status === 0 && /^ +Agent applications: +○ not set up$/m.test(human.stdout) && /^Next\n +cotal setup +Set up an agent application/m.test(human.stdout), shown(human));
}

// ── A command that is not a read still meets the gate ───────────────────────────────────────────────
{
  const { run } = sandbox();
  for (const args of [["space", "forget", "nope"], ["ext", "add", "@acme/none"]]) {
    const r = run(args);
    check(`${args.join(" ")} is not a read: the seed gate runs first and refuses from a source checkout`, r.status === 1 && GATE.test(r.stderr), shown(r));
  }
}

// ── A read never loads a built-in installed at another version ──────────────────────────────────────
{
  const { home, xdg, run } = sandbox();
  const pkg = "@cotal-ai/connector-claude-code";
  const pkgDir = join(xdg, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-claude-code");
  mkdirSync(pkgDir, { recursive: true });
  const marker = join(home, "imported");
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version: "0.0.1", type: "module", main: "index.js" }));
  writeFileSync(join(pkgDir, "index.js"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "imported");\n`);
  writeFileSync(join(xdg, "cotal", "extensions", "extensions.json"), JSON.stringify({
    extensions: [{
      pkg, version: "0.0.1", spec: `${pkg}@0.0.1`, source: "seeded",
      provides: [{ kind: "connector", name: "claude" }, { kind: "connector-setup", name: "claude" }], commands: [],
      connectors: [{ name: "claude", requires: [], setup: { kind: "connector-setup", name: "claude" } }],
    }],
  }));
  const r = run(["status", "--json"]);
  let rows: { name: string; state: string; text: string }[] = [];
  try {
    rows = (JSON.parse(r.stdout) as { result: { machine: { integrations: typeof rows } } }).result.machine.integrations;
  } catch {
    rows = [];
  }
  const row = rows.find((i) => i.name === "claude setup");
  check("status names the older built-in and the command that brings it to this version",
    row?.state === "error" && row.text === `${pkg} is 0.0.1 and this cotal is ${VERSION} - run \`cotal ext seed\` to bring it to this version`, { status: r.status, rows });
  check("and never imported it", !existsSync(marker));
}

// A real ext add must preserve the declaration the lazy command's seed decision reads.
{
  const { home, xdg, run } = sandbox();
  const fixture = join(home, "read-extension");
  mkdirSync(fixture);
  writeFileSync(join(fixture, "package.json"), JSON.stringify({
    name: "read-cache-fixture", version: "1.0.0", type: "module", main: "index.js",
    peerDependencies: { "@cotal-ai/core": "*" },
  }));
  const core = pathToFileURL(join(import.meta.dirname, "..", "..", "..", "packages", "core", "dist", "index.js")).href;
  writeFileSync(join(fixture, "index.js"), `import { registry } from ${JSON.stringify(core)};
registry.register({ kind: "command", name: "inspect-read-cache", summary: "owned read fixture", reads: true,
  positionals: "[list | write]", subcommands: [{ name: "list", summary: "read list", reads: true }, { name: "write", summary: "non-read control" }],
  run: async () => console.log("fixture-read-ran") });
`);
  const added = run(["ext", "add", fixture], { COTAL_SKIP_CONNECTOR_SEED: "1" });
  check("control: real ext add caches the owned read extension", added.status === 0 && existsSync(join(xdg, "cotal", "extensions", "extensions.json")), shown(added));
  const bare = run(["inspect-read-cache"]);
  check("an installed bare read runs past the seed gate", bare.status === 0 && bare.stdout.trim() === "fixture-read-ran" && !GATE.test(bare.stderr), shown(bare));
  const sub = run(["inspect-read-cache", "list"]);
  check("an installed read subcommand runs past the seed gate", sub.status === 0 && sub.stdout.trim() === "fixture-read-ran" && !GATE.test(sub.stderr), shown(sub));
  const write = run(["inspect-read-cache", "write"]);
  check("an installed non-read subcommand still meets the seed gate", write.status === 1 && GATE.test(write.stderr) && !write.stdout.includes("fixture-read-ran"), shown(write));
}

finish();
