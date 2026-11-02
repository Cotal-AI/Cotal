/** Documentation links through the built CLI, on real terminals and redirected output.
 *  Offline, with no broker or agent. Run: pnpm smoke:docs-links */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";
import { ptySpawn, screen, wait, type Pty } from "../../implementations/cli/smoke/_console-pty.js";

const BIN = join(import.meta.dirname, "..", "dist", "cotal.js");
const home = mkdtempSync(join(tmpdir(), "cotal-docs-links-"));
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("COTAL_")) env[key] = value;
Object.assign(env, {
  HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
  XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
  COTAL_HOME: join(home, "cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off",
  TERM: "xterm-256color",
});
const { check, finish } = createSuite();
const active = new Set<Pty>();

async function until(done: () => boolean, ms = 30_000): Promise<boolean> {
  for (const start = Date.now(); Date.now() - start < ms; await wait(50)) if (done()) return true;
  return done();
}

async function terminal(args: string[], cols: number) {
  const pty = ptySpawn(process.execPath, [BIN, ...args], { cwd: home, env, cols, rows: 50, name: "xterm-256color" });
  active.add(pty);
  let raw = "";
  let exitCode: number | undefined;
  pty.onData((data) => { raw += data; });
  pty.onExit((event) => { exitCode = event.exitCode; active.delete(pty); });
  if (!await until(() => exitCode !== undefined)) throw new Error(`docs child did not exit at ${cols} columns`);
  return { exitCode, text: await screen(raw, cols, 50) };
}

function pipe(args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: home, env, encoding: "utf8", timeout: 30_000 });
}

try {
  const json = pipe(["docs", "cli", "--json"]);
  const result = JSON.parse(json.stdout).result as { slug: string; body: string };
  const daemon = "cli-processes.mdx#daemon";
  const markdownLink = `[Command reference](${daemon})`;
  check("JSON preserves the hub's Markdown links", json.status === 0 && result.slug === "cli" && result.body.includes(markdownLink));
  const targets = [...result.body.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!);
  check("the hub supplies page links and the daemon section reference", targets.includes("cli-selection.mdx") && targets.includes("getting-started.mdx") && targets.includes(daemon));

  for (const cols of [40, 80, 120]) {
    const page = await terminal(["docs", "cli"], cols);
    const missing = targets.filter((target) => !page.text.includes(`<${target}>`));
    check(`the ${cols}-column terminal retains every hub link destination`, page.exitCode === 0 && missing.length === 0, { exitCode: page.exitCode, missing });
    check(`the ${cols}-column terminal still draws Markdown headings and links`, !/^#{1,6} /m.test(page.text) && !page.text.includes(markdownLink));
  }

  const piped = pipe(["docs", "cli"]);
  const plain = pipe(["docs", "cli", "--plain"]);
  check("piped and plain pages retain Markdown without presentation changes", piped.status === 0 && plain.status === 0 && piped.stdout === plain.stdout && piped.stdout.includes(markdownLink));
  const plainTty = await terminal(["docs", "cli", "--plain"], 80);
  check("--plain on a terminal retains Markdown links", plainTty.exitCode === 0 && plainTty.text.includes(markdownLink));

  const followed = pipe(["docs", daemon, "--json"]);
  const destination = JSON.parse(followed.stdout).result as { slug: string; body: string };
  check("the displayed page and anchor reference opens through the CLI", followed.status === 0 && destination.slug === "cli-processes" && destination.body.length > 0);
} finally {
  for (const pty of active) pty.kill();
  if (!await until(() => active.size === 0, 5_000)) throw new Error(`docs children have not exited; retained ${home}`);
  rmSync(home, { recursive: true, force: true });
}
finish();
