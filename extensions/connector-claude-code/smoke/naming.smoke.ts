/**
 * The Claude Code connector's naming request (SPEC 13.22): what the `claude` it runs receives and how
 * its answer is read, against a stand-in `claude` that records its argv, stdin, directory and env.
 * Also the launch env that turns naming on for the seat's MCP server.
 *
 * Covered: one `claude -p` with no tools, no MCP server, hooks off and no saved session, the agreed
 * system prompt, the seat's model when it pinned one, and the message on stdin and never in argv; the
 * session's provider keys pass and host-session markers and `COTAL_*` do not; it runs in an empty
 * private directory that is removed after; a failed run rejects with claude's own error; an abort stops
 * the process. `buildLaunch` carries `COTAL_AUTO_NAME`, the launch prompt and the resolved binary only
 * for a launch that names itself.
 *
 * Run: pnpm smoke:claude-naming
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";
import { discardLaunchArtifacts } from "@cotal-ai/core";
import { nameRequest } from "../../connector-core/src/agent-naming.js";
import { claudeNaming } from "../src/naming.js";
import { claudeConnector } from "../src/extension.js";

const { check, finish } = createSuite();
const root = mkdtempSync(join(tmpdir(), "claude-naming-"));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A stand-in `claude` that records what it was given to `<name>.json`, then runs `body`. */
function fakeClaude(name: string, body: string): { bin: string; record: () => { argv: string[]; cwd: string; stdin: string; env: Record<string, string>; pid: number } } {
  const bin = join(root, name);
  const record = join(root, `${name}.json`);
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin, env: process.env, pid: process.pid, entries: fs.readdirSync(process.cwd()) }));
  ${body}
});
`);
  chmodSync(bin, 0o755);
  return { bin, record: () => JSON.parse(readFileSync(record, "utf8")) };
}

const session = (bin: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, HOME: process.env.HOME,
  COTAL_CLAUDE_RESOLVED_BIN: bin, COTAL_SPACE: "smoke", COTAL_NAME: "coder",
  CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli",
  ANTHROPIC_API_KEY: "sk-smoke", CLAUDE_CONFIG_DIR: join(root, "claude-config"),
});
const ask = (env: NodeJS.ProcessEnv, model: string | undefined, text: string, signal = new AbortController().signal) =>
  claudeNaming(env, model).request({ ...nameRequest(text), signal });
async function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  try { return { ok: true, value: await p }; } catch (error) { return { ok: false, error: error as Error }; }
}

try {
  console.log("a request that answers");
  {
    const claude = fakeClaude("answers", `process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Production 500 errors" }));`);
    const answer = await ask(session(claude.bin), "claude-opus-5-5", "look into the flaky checkout-service canary");
    const seen = claude.record();
    const { system, prompt } = nameRequest("look into the flaky checkout-service canary");
    check("it resolves to claude's result text", answer === "Production 500 errors", answer);
    check("claude runs one print-mode request with no tools, no MCP server, hooks off and no saved session",
      same(seen.argv.slice(0, 10), ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--settings", '{"disableAllHooks":true}', "--no-session-persistence", "--system-prompt"]), seen.argv);
    check("with the agreed system prompt and the seat's model", same(seen.argv.slice(10), [system, "--model", "claude-opus-5-5"]), seen.argv.slice(10));
    check("the message goes in on stdin, and never in argv", seen.stdin === prompt && !seen.argv.some((a) => a.includes("checkout-service canary")), seen.stdin);
    check("the session's provider keys reach claude", seen.env.ANTHROPIC_API_KEY === "sk-smoke" && seen.env.CLAUDE_CONFIG_DIR === join(root, "claude-config"), seen.env);
    check("host-session markers and COTAL_ names do not", !("CLAUDECODE" in seen.env) && !("CLAUDE_CODE_ENTRYPOINT" in seen.env) && !Object.keys(seen.env).some((k) => k.startsWith("COTAL_")),
      Object.keys(seen.env));
    check("it runs in an empty private directory, removed afterwards",
      seen.cwd.startsWith(tmpdir()) && same((seen as unknown as { entries: string[] }).entries, []) && !existsSync(seen.cwd), seen.cwd);
    const unpinned = fakeClaude("unpinned", `process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "x" }));`);
    await ask(session(unpinned.bin), undefined, "hello");
    check("a seat that pinned no model passes none, so claude uses the login's own", !unpinned.record().argv.includes("--model"), unpinned.record().argv);
  }

  console.log("\na request that fails");
  {
    const apiError = fakeClaude("api-error", `process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "API Error: 400 unknown provider for model x" })); process.exitCode = 1;`);
    const r1 = await settled(ask(session(apiError.bin), "x", "hello"));
    check("an error result rejects with claude's own error text", !r1.ok && r1.error.message.includes("API Error: 400 unknown provider for model x"), r1);
    const crash = fakeClaude("crash", `process.stderr.write("not logged in"); process.exitCode = 1;`);
    const r2 = await settled(ask(session(crash.bin), undefined, "hello"));
    check("a run with no result rejects with its stderr", !r2.ok && r2.error.message.includes("not logged in"), r2);
    const r3 = await settled(ask(session(join(root, "no-such-claude")), undefined, "hello"));
    check("a missing binary rejects", !r3.ok, r3);
  }

  console.log("\nan aborted request");
  {
    const hangs = fakeClaude("hangs", `setInterval(() => {}, 1000);`);
    const abort = new AbortController();
    const started = Date.now();
    const pending = settled(ask(session(hangs.bin), undefined, "hello", abort.signal));
    for (let i = 0; i < 100 && !existsSync(join(root, "hangs.json")); i++) await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    const r = await pending;
    const pid = hangs.record().pid;
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    check("rejects at once and the claude process is gone", !r.ok && Date.now() - started < 5_000 && !alive, { r, alive });
  }

  console.log("\nthe launch prompt");
  {
    check("the seat's launch prompt is its first message, and a launch with none has none",
      claudeNaming({ COTAL_CLAUDE_PROMPT: "triage issue 42" }, undefined).launchPrompt === "triage issue 42" && claudeNaming({}, undefined).launchPrompt === undefined);
  }

  console.log("\nthe launch env");
  {
    const opts = { space: "smoke", name: "claude-1", events: false, prompt: "triage issue 42", resolvedBinaries: { claude: "/opt/claude/bin/claude" } };
    const on = claudeConnector.buildLaunch({ ...opts, autoName: true } as never);
    const off = claudeConnector.buildLaunch(opts as never);
    discardLaunchArtifacts(on.artifacts ?? []);
    discardLaunchArtifacts(off.artifacts ?? []);
    check("a launch that names itself carries COTAL_AUTO_NAME, its prompt and the resolved claude",
      on.env?.COTAL_AUTO_NAME === "1" && on.env?.COTAL_CLAUDE_PROMPT === "triage issue 42" && on.env?.COTAL_CLAUDE_RESOLVED_BIN === "/opt/claude/bin/claude",
      on.env && { a: on.env.COTAL_AUTO_NAME, p: on.env.COTAL_CLAUDE_PROMPT, b: on.env.COTAL_CLAUDE_RESOLVED_BIN });
    check("any other launch carries none of them",
      off.env !== undefined && !("COTAL_AUTO_NAME" in off.env) && !("COTAL_CLAUDE_PROMPT" in off.env) && !("COTAL_CLAUDE_RESOLVED_BIN" in off.env));
  }
} catch (e) {
  check(`the suite threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  rmSync(root, { recursive: true, force: true });
}
finish();
