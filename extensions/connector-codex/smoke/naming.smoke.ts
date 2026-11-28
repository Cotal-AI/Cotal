/**
 * The Codex connector's naming request (SPEC 13.22): what the `codex exec` it runs receives and how
 * its answer is read, against a stand-in `codex` that records its argv, stdin, directory and env.
 *
 * Covered: one ephemeral `codex exec` on the seat's CODEX_HOME that ignores any config file there, with
 * the seat's own `-c` overrides first and low reasoning, a read-only sandbox and web search off after
 * them, so they win; a seat on the priority (Fast) tier asked on the default tier, any other tier
 * kept; every codex feature that gives the model a tool or runs a command turned off;
 * the seat's model when the launch pinned none; the request on stdin and never in argv; no `COTAL_*` in its env; an empty private
 * directory removed after; the last message read back; a failed turn rejects with codex's reason; an
 * abort stops the process.
 *
 * Run: pnpm smoke:codex-naming
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";
import { nameRequest } from "../../connector-core/src/agent-naming.js";
import { codexNaming, type CodexNamingSeat } from "../src/naming.js";

const { check, finish } = createSuite();
const root = mkdtempSync(join(tmpdir(), "codex-naming-"));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A stand-in `codex` that records what it was given to `<name>.json`, then runs `body` with `out`, the
 *  `--output-last-message` path, in scope. */
function fakeCodex(name: string, body: string): { bin: string; record: () => { argv: string[]; cwd: string; stdin: string; env: Record<string, string>; pid: number; entries: string[] } } {
  const bin = join(root, name);
  const record = join(root, `${name}.json`);
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  const out = argv[argv.indexOf("--output-last-message") + 1];
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, cwd: process.cwd(), stdin, env: process.env, pid: process.pid, entries: fs.readdirSync(process.cwd()) }));
  ${body}
});
`);
  chmodSync(bin, 0o755);
  return { bin, record: () => JSON.parse(readFileSync(record, "utf8")) };
}

const seat = (bin: string, over: Partial<CodexNamingSeat> = {}): CodexNamingSeat => ({
  bin, codexHome: join(root, "agent-home"),
  overrides: [["model_reasoning_effort", '"high"'], ["approval_policy", '"never"'], ["sandbox_mode", '"workspace-write"']],
  model: () => "gpt-6.2",
  ...over,
});
const TEXT = "look into the flaky checkout-service canary";
const ask = (s: CodexNamingSeat, signal = new AbortController().signal) => codexNaming(s).request({ ...nameRequest(TEXT), signal });
async function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  try { return { ok: true, value: await p }; } catch (error) { return { ok: false, error: error as Error }; }
}
const configs = (argv: string[]) => argv.flatMap((a, i) => (argv[i - 1] === "-c" ? [a] : []));
const disabled = (argv: string[]) => argv.flatMap((a, i) => (argv[i - 1] === "--disable" ? [a] : []));
/** The features `codex features list` shows on in codex-cli 0.170.0 that give the model a tool (the shell,
 *  images, sleep, apps, plugins, browser and computer use, image generation, goals, skills, tool
 *  suggestions, sub-agents) or run a command (hooks, the shell snapshot). */
const TOOL_FEATURES = [
  "apps", "browser_annotation_api", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use",
  "goals", "hooks", "image_generation", "in_app_browser", "multi_agent", "plugins", "remote_plugin", "shell_snapshot",
  "shell_tool", "skill_mcp_dependency_install", "skill_search", "sleep_tool", "tool_suggest", "unified_exec", "view_image",
];

process.env.COTAL_SPACE = "smoke";
process.env.COTAL_CREDS_FILE = "/should/not/reach/codex";

try {
  console.log("a request that answers");
  {
    const codex = fakeCodex("answers", `fs.writeFileSync(out, "Checkout canary flake\\n"); console.log(JSON.stringify({ type: "turn.completed" }));`);
    const answer = await ask(seat(codex.bin));
    const seen = codex.record();
    const { system, prompt } = nameRequest(TEXT);
    check("it resolves to codex's last message", answer === "Checkout canary flake\n", answer);
    check("codex runs one ephemeral exec that ignores the config file in CODEX_HOME and reads its request from stdin",
      same(seen.argv.slice(0, 6), ["exec", "--ephemeral", "--skip-git-repo-check", "--ignore-rules", "--ignore-user-config", "--json"]) && seen.argv.at(-1) === "-", seen.argv);
    check("the seat's overrides come first, then the seat's model, low reasoning, a read-only sandbox and web search off, so the later ones win",
      same(configs(seen.argv), ['model_reasoning_effort="high"', 'approval_policy="never"', 'sandbox_mode="workspace-write"', 'model="gpt-6.2"', 'model_reasoning_effort="low"', 'sandbox_mode="read-only"', 'web_search="disabled"']),
      configs(seen.argv));
    check(`it turns off all ${TOOL_FEATURES.length} codex features that give the model a tool or run a command, and only those`,
      same([...disabled(seen.argv)].sort(), [...TOOL_FEATURES].sort()), disabled(seen.argv));
    check("the instruction and the message go in on stdin, and never in argv", seen.stdin === `${system}\n\n${prompt}` && !seen.argv.some((a) => a.includes("checkout-service canary")), seen.stdin.slice(-120));
    check("it runs on the seat's CODEX_HOME with no COTAL_ names", seen.env.CODEX_HOME === join(root, "agent-home") && !Object.keys(seen.env).some((k) => k.startsWith("COTAL_")), Object.keys(seen.env).filter((k) => k.startsWith("CO")));
    check("in an empty private directory, removed afterwards", seen.cwd.startsWith(tmpdir()) && same(seen.entries, []) && !existsSync(seen.cwd), seen.cwd);
    const pinned = fakeCodex("pinned", `fs.writeFileSync(out, "x");`);
    await ask(seat(pinned.bin, { overrides: [["model", '"gpt-pinned"']] }));
    const tierOf = async (name: string, tier: string) => {
      const c = fakeCodex(name, `fs.writeFileSync(out, "x");`);
      await ask(seat(c.bin, { overrides: [["service_tier", tier]] }));
      return configs(c.record().argv).filter((a) => a.startsWith("service_tier="));
    };
    const fast = await tierOf("fast", '"priority"');
    check("a Fast seat's request runs on the default tier, after the seat's priority so it wins", same(fast, ['service_tier="priority"', 'service_tier="default"']), fast);
    const bare = await tierOf("fast-bare", "priority");
    check("an operator's unquoted priority tier is turned down too", same(bare, ["service_tier=priority", 'service_tier="default"']), bare);
    const flex = await tierOf("flex", '"flex"');
    check("any other tier the seat runs is kept", same(flex, ['service_tier="flex"']), flex);
    check("a launch that pinned its model keeps it, and the thread's model is not added", same(configs(pinned.record().argv).filter((c) => c.startsWith("model=")), ['model="gpt-pinned"']), configs(pinned.record().argv));
  }

  console.log("\na request that fails");
  {
    const failed = fakeCodex("fails", `console.log(JSON.stringify({ type: "error", message: "Reconnecting... 1/5" })); console.log(JSON.stringify({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } })); process.exitCode = 1;`);
    const r1 = await settled(ask(seat(failed.bin)));
    check("a failed turn rejects with codex's reason", !r1.ok && r1.error.message.includes("unexpected status 401 Unauthorized"), r1);
    const crash = fakeCodex("crash", `process.stderr.write("config error"); process.exitCode = 2;`);
    const r2 = await settled(ask(seat(crash.bin)));
    check("a run with no turn rejects with its stderr", !r2.ok && r2.error.message.includes("config error"), r2);
  }

  console.log("\nan aborted request");
  {
    const hangs = fakeCodex("hangs", `setInterval(() => {}, 1000);`);
    const abort = new AbortController();
    const pending = settled(ask(seat(hangs.bin), abort.signal));
    for (let i = 0; i < 100 && !existsSync(join(root, "hangs.json")); i++) await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    const r = await pending;
    let alive = true;
    try { process.kill(hangs.record().pid, 0); } catch { alive = false; }
    check("rejects and the codex process is gone", !r.ok && !alive, { r, alive });
  }
} catch (e) {
  check(`the suite threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  rmSync(root, { recursive: true, force: true });
}
finish();
