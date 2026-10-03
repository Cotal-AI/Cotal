/**
 * The per-session MCP server stays small: it is launched with node's memory-saving flags, and its
 * bundles are pure ASCII. No `claude` binary, no broker - this drives `buildLaunch`, reads the plugin
 * manifest and the built bundles, and runs node with the flags.
 *
 * WHY THIS EXISTS. Every managed session runs its own `node dist/mcp.cjs`, so whatever it holds is
 * paid once per agent. Two things made it larger than its work needs, both silent:
 *   - one non-ASCII character anywhere in the bundle makes node hold ALL of its source as a two-byte
 *     string (a `µ` in @nats-io/jetstream's duration regex: 4.2MB on disk, 8.2MB resident);
 *   - V8's default young generation sizes for throughput, and an idle relay keeps ~9MB of it empty.
 * A heap-size threshold would be flaky, so the suite asserts the CAUSES instead: the bytes are ASCII
 * and the launch carries the flags.
 *
 * THE fetch CELLS ARE THE LOAD-BEARING ONES. `--lite-mode`/`--jitless` save more and look like the
 * obvious next step, but they remove `WebAssembly`, and node's `fetch` parses HTTP with a wasm
 * module - the server's own `fetch` calls (cotal_docs refresh, feedback) would fail at runtime. The
 * jitless control proves the cell can tell.
 *
 * Run: pnpm smoke:claude-mcp-footprint
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeConnector } from "../src/extension.js";
// @ts-expect-error - a plain .mjs build script with no type declarations
import { asciiOnly } from "../build.mjs";

const FLAGS = ["--optimize-for-size", "--max-semi-space-size=1"];
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

console.log("claude connector: the per-session MCP server launches lean");

type Server = { command: string; args: string[] };
const cotalServer = (config: string): Server | undefined =>
  (JSON.parse(config) as { mcpServers: Record<string, Server> }).mcpServers.cotal;

// ---- the managed launch: the config buildLaunch hands to claude --------------------------------
{
  const spec = claudeConnector.buildLaunch({ space: "s", name: "seat", events: false } as never) as { args: string[] };
  const i = spec.args.indexOf("--mcp-config");
  const raw = i >= 0 ? spec.args[i + 1] : undefined;
  const config = raw === undefined ? undefined : raw.trimStart().startsWith("{") ? raw : readFileSync(raw, "utf8");
  const cotal = config === undefined ? undefined : cotalServer(config);
  check("the launch carries a cotal MCP server", cotal !== undefined, spec.args);
  check("it runs under node", cotal?.command === "node", cotal);
  check(
    "node gets the footprint flags, ahead of the bundle path",
    JSON.stringify(cotal?.args.slice(0, -1)) === JSON.stringify(FLAGS) && /dist[\\/]mcp\.cjs$/.test(cotal?.args.at(-1) ?? ""),
    cotal?.args,
  );
}

// ---- the installed plugin: .mcp.json, used when the plugin serves a personal session -------------
{
  const cotal = cotalServer(readFileSync(join(PKG, ".mcp.json"), "utf8"));
  check(
    ".mcp.json passes the same flags, so a plugin session is not the larger one",
    cotal?.command === "node" &&
      JSON.stringify(cotal.args) === JSON.stringify([...FLAGS, "${CLAUDE_PLUGIN_ROOT}/dist/mcp.cjs"]),
    cotal,
  );
}

// ---- the flags keep fetch working; the jitless control proves this cell can fail -----------------
const FETCH_PROBE = `
const http = require("node:http");
const s = http.createServer((q, r) => r.end("ok")).listen(0, "127.0.0.1", async () => {
  try { const r = await fetch("http://127.0.0.1:" + s.address().port); process.stdout.write(await r.text()); }
  catch (e) { process.stdout.write("FAIL " + (e.cause?.message ?? e.message)); }
  s.close();
});`;
const fetchUnder = (flags: string[]) =>
  spawnSync(process.execPath, [...flags, "-e", FETCH_PROBE], { encoding: "utf8", timeout: 20_000 }).stdout;
check("fetch works under the footprint flags", fetchUnder(FLAGS) === "ok", fetchUnder(FLAGS));
check("control: under --jitless the same probe fails", fetchUnder(["--jitless"]) !== "ok");

// ---- the ASCII rewrite ---------------------------------------------------------------------------
{
  const src = 'module.exports = { re: /(\\d+)(ns|µs|ms)/, s: "§ 13.2", t: `ok ${1} 😀` }; // § kept comment';
  const out = asciiOnly(src) as string;
  check("the rewrite leaves no non-ASCII byte", !/[^\x00-\x7f]/.test(out), out);
  const before = { exports: {} as Record<string, unknown> };
  const after = { exports: {} as Record<string, unknown> };
  new Function("module", src)(before);
  new Function("module", out)(after);
  const b = before.exports as { re: RegExp; s: string; t: string };
  const a = after.exports as { re: RegExp; s: string; t: string };
  check("an escaped regex matches what the original matched", a.re.test("5µs") && b.re.test("5µs") && !a.re.test("5xs"));
  check("an escaped string is the same string", a.s === b.s);
  check("a character outside the BMP survives as its surrogate pair", a.t === b.t);
  let refused = "";
  try {
    asciiOnly("const x = String.raw`µ`;");
  } catch (e) {
    refused = (e as Error).message;
  }
  check("a non-ASCII String.raw is refused, since escaping it would change it", /String\.raw/.test(refused), refused);
}

// ---- the shipped bundles -------------------------------------------------------------------------
for (const file of ["dist/mcp.cjs", "dist/hook.cjs"]) {
  const path = join(PKG, file);
  const present = existsSync(path);
  check(`${file} is built (run through pnpm smoke:claude-mcp-footprint, which builds first)`, present);
  if (present) {
    const text = readFileSync(path, "latin1");
    const at = text.search(/[^\x00-\x7f]/);
    check(`${file} is pure ASCII, so node holds its source one byte per character`, at < 0, at < 0 ? "" : text.slice(Math.max(0, at - 60), at + 20));
  }
}

// ---- the cell count, because the bundle cells are conditional ------------------------------------
const EXPECTED = 15;
check(`every cell ran - ${EXPECTED} expected`, pass + fail === EXPECTED, `${pass + fail} cells reported`);

console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
