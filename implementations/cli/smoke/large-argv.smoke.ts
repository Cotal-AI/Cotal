/**
 * #4088: a command that renders no TUI must not load Ink or its wasm layout engine.
 *
 * `implementations/cli/src/index.ts` imports `commands/console.ts` for every command. That file
 * imported `ink` and the console UI at module top, so every `cotal` invocation loaded
 * `yoga-layout`, whose wasm init is a top-level await. On macOS that await never settles once the
 * process starts with a few hundred KB of argv, and Node exits 13 with only its "unsettled
 * top-level await" warning: `cotal send dm <name> "<480 KB text>"` sent nothing.
 *
 * Two cells, both against the BUILT binary (`bin/dist/cotal.js`) in a throwaway COTAL_HOME and
 * XDG_CONFIG_HOME with connector seeding off, so nothing here reads or writes a real mesh:
 *   1. the module graph of `cotal --version` holds no `ink` or `yoga-layout` file. This is the
 *      cause, and it holds on every platform.
 *   2. `cotal --version` with 640 KB of argv reaches the argument parser, which refuses the extra
 *      words with exit 1. This is the symptom: the stall exits 13 before any parser runs. The stall
 *      reproduces on macOS only (Linux with Node 22 and 24 did not stall when measured), so on Linux
 *      this cell passes either way and cell 1 is the guard. It does not run on Windows, whose
 *      command line is capped at 32,767 characters.
 *
 * Requires the binary built (`pnpm --filter cotal-ai... build`); `pnpm smoke:large-argv` does that
 * first. Run: pnpm smoke:large-argv
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";

const REPO = join(import.meta.dirname, "..", "..", "..");
const BIN = join(REPO, "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing: build first with pnpm --filter cotal-ai... build`);
  process.exit(1);
}

const { check, finish } = createSuite();

const dir = mkdtempSync(join(tmpdir(), "cotal-large-argv-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

// A harness running inside a seat carries COTAL_* state that could point the CLI at a live mesh.
const env: Record<string, string | undefined> = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_"))),
  COTAL_HOME: join(dir, "home"),
  XDG_CONFIG_HOME: join(dir, "xdg"),
  COTAL_SKIP_CONNECTOR_SEED: "1",
};

function cotal(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Cell 1: record every module URL the process resolves and print the Ink/yoga ones on exit.
const hook = join(dir, "record-ui-modules.mjs");
writeFileSync(
  hook,
  [
    'import { registerHooks } from "node:module";',
    "const hits = new Set();",
    "registerHooks({ resolve(spec, ctx, next) { const r = next(spec, ctx);",
    "  if (/[\\\\/]node_modules[\\\\/](ink|yoga-layout)[\\\\/]/.test(decodeURIComponent(r.url))) hits.add(r.url);",
    "  return r; } });",
    'process.on("exit", () => process.stderr.write("UI_MODULES " + JSON.stringify([...hits]) + "\\n"));',
    "",
  ].join("\n"),
);
{
  const r = cotal(["--version"], { NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` });
  const line = r.stderr.split("\n").find((l) => l.startsWith("UI_MODULES "));
  const loaded = line ? (JSON.parse(line.slice("UI_MODULES ".length)) as string[]) : undefined;
  check("cotal --version ran under the module recorder", r.status === 0 && loaded !== undefined, r);
  check("cotal --version loads no ink or yoga-layout module", loaded !== undefined && loaded.length === 0, loaded?.slice(0, 5));
}

// Cell 2: ten 64,000-byte words, each under Linux's 128 KiB per-argument cap.
if (process.platform === "win32") {
  console.log("  - large-argv run not attempted: the Windows command line is capped at 32,767 characters");
} else {
  const words = Array.from({ length: 10 }, () => "x".repeat(64_000));
  const r = cotal(["--version", ...words]);
  check(
    "cotal --version with 640 KB of argv reaches the argument parser, which refuses the extra words",
    r.status === 1 && r.stderr.startsWith("✗ Unexpected argument 'xxxx") && !/top-level await/.test(r.stderr),
    { status: r.status, signal: r.signal, stdout: r.stdout.slice(0, 200), stderr: r.stderr.slice(0, 400) },
  );
}

finish();
