/**
 * The lists a launcher reads before launch (`Connector.commands`, SPEC 13.22), from stand-in
 * harnesses, and the first command each connector hands its seat. Claude's list keeps what the
 * command mod lets a remote request run, pi's names skills as skills and trusts a project as a
 * supervised seat does, OpenCode 1.x's comes from a private server it stops, an install too old to
 * run agent commands lists `supported: false`, and every connector writes a spawn's first command to
 * a launch file its seat takes once.
 *
 * Run: pnpm smoke:command-catalogs
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discardLaunchArtifacts, type CommandCatalog, type Connector, type FirstCommand, type LaunchSpec } from "@cotal-ai/core";
import { createSuite, skipSuite } from "@cotal-ai/smoke-kit";
import { claudeConnector } from "../../extensions/connector-claude-code/src/extension.js";
import { codexConnector } from "../../extensions/connector-codex/src/extension.js";
import { codexSkillEntries } from "../../extensions/connector-codex/src/skills.js";
import { opencodeConnector } from "../../extensions/connector-opencode/src/extension.js";
import { piConnector } from "../../extensions/pi/src/connector.js";

if (process.platform === "win32") skipSuite("the stand-in harnesses are POSIX shell scripts");

const { check, finish } = createSuite();
const dir = mkdtempSync(join(tmpdir(), "command-catalogs-smoke-"));
const project = realpathSync(mkdtempSync(join(dir, "project-")));
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const lines = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

function standIn(name: string, script: string, vars: Record<string, string>): { bin: string; log: string } {
  const home = mkdtempSync(join(dir, `${name}-`));
  const bin = join(home, name), log = join(home, "log.jsonl");
  const assign = Object.entries({ ...vars, FAKE_CLAUDE_LOG: log, FAKE_PI_LOG: log, FAKE_OC1_LOG: log }).map(([k, v]) => `${k}='${v}'`).join(" ");
  writeFileSync(bin, `#!/bin/sh\n${assign} exec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(bin, 0o700);
  return { bin, log };
}

// ---- Claude Code --------------------------------------------------------------------------------
{
  const FAKE = fileURLToPath(new URL("../../extensions/connector-claude-code/smoke/fake-claude-models.mjs", import.meta.url));
  const recorded = JSON.parse(readFileSync(new URL("../../extensions/connector-claude-code/smoke/fixtures/claude-initialize-commands.json", import.meta.url), "utf8")).response;
  const reply = join(dir, "claude-reply.json");
  writeFileSync(reply, JSON.stringify(recorded));
  const claude = standIn("claude", FAKE, { FAKE_CLAUDE_REPLY: reply });
  const list = (bin: string): Promise<CommandCatalog> => claudeConnector.commands!.list({ cwd: project, resolvedBinaries: { claude: bin } });
  const catalog = await list(claude.bin);
  check("claude: the list keeps the project's command and skill, with the command's argument hint", catalog.supported && same(catalog.commands.filter((c) => c.name.startsWith("lane-")), [
    { name: "lane-skill", target: "command", description: "Lane D custom skill (project)" },
    { name: "lane-cmd", target: "command", description: "Lane D custom command (project)", inputHint: "<topic>" },
  ]), catalog);
  const names = catalog.supported ? catalog.commands.map((c) => c.name) : [];
  check("claude: a built-in the command mod allows stays, and ones it refuses or has no row for go", ["compact", "init"].every((n) => names.includes(n)) && !["model", "usage", "heapdump"].some((n) => names.includes(n)), names);
  const started = lines(claude.log).find((e) => e.argv);
  check("claude: it asks a claude started in the launch's directory, with no MCP server, no hooks and no saved session",
    started?.cwd === project && ["--strict-mcp-config", '{"disableAllHooks":true}', "--no-session-persistence"].every((a) => started.argv.includes(a)), started);
  writeFileSync(reply, JSON.stringify({ ...recorded, response: { ...recorded.response, response: { ...recorded.response.response, claude_code_version: "2.1.300 (Claude Code)" } } }));
  const old = await list(claude.bin);
  check("claude: a Claude Code older than the command mod's floor lists supported: false, naming its version", !old.supported && /2\.1\.300.*older than 2\.1\.330/.test(old.reason), old);
  writeFileSync(reply, JSON.stringify("exit"));
  const failed = await list(claude.bin).then(() => "listed", (e: Error) => e.message);
  check("claude: a claude that exits before answering is a failed read, never an empty list", /exited \(3\)/.test(failed), failed);
}

// ---- pi -----------------------------------------------------------------------------------------
{
  const FAKE = fileURLToPath(new URL("../../extensions/pi/smoke/fake-pi.mjs", import.meta.url));
  const reply = join(dir, "pi-reply.json");
  writeFileSync(reply, JSON.stringify({ type: "response", command: "get_commands", success: true, data: { commands: [
    { name: "plan", description: "an extension command", source: "extension" },
    { name: "lane-cmd", description: "Lane D pi template", source: "prompt" },
    { name: "plan", description: "a template shadowed by the extension command", source: "prompt" },
    { name: "skill:lane-skill", description: "Lane D custom skill", source: "skill" },
  ] } }));
  const pi = standIn("pi", FAKE, { FAKE_PI_MODE: "reply", FAKE_PI_REPLY: reply });
  const catalog = await piConnector.commands!.list({ cwd: project, resolvedBinaries: { pi: pi.bin } });
  check("pi: commands and templates are commands, skills are skills under their own name, and the first of a name is the one listed", same(catalog, { supported: true, commands: [
    { name: "plan", target: "command", description: "an extension command" },
    { name: "lane-cmd", target: "command", description: "Lane D pi template" },
    { name: "lane-skill", target: "skill", description: "Lane D custom skill" },
  ] }), catalog);
  const rpc = lines(pi.log).find((e) => e.argv?.includes("--mode"));
  const trustAt = rpc?.argv.indexOf("--extension");
  check("pi: it asks a pi in RPC mode in the launch's directory, which loads the seat's trust rule", rpc?.cwd === project && trustAt >= 0 && /trust-entry\.js$/.test(rpc.argv[trustAt + 1]) && rpc.seatIdentity === false, rpc);
  const old = standIn("pi", FAKE, { FAKE_PI_MODE: "reply", FAKE_PI_REPLY: reply, FAKE_PI_VERSION: "0.84.1" });
  const tooOld = await piConnector.commands!.list({ cwd: project, resolvedBinaries: { pi: old.bin } });
  check("pi: a pi older than 0.84.2 lists supported: false and is never asked for its commands", !tooOld.supported && /0\.84\.1/.test(tooOld.reason) && !lines(old.log).some((e) => e.command), tooOld);
}

// ---- OpenCode 1.x -------------------------------------------------------------------------------
{
  const FAKE = fileURLToPath(new URL("../../extensions/connector-opencode/smoke/fixtures/fake-opencode1-serve.mjs", import.meta.url));
  const reply = join(dir, "opencode1-reply.json");
  writeFileSync(reply, JSON.stringify([
    { name: "init", description: "guided AGENTS.md setup", source: "command", template: "Create or update AGENTS.md" },
    { name: "lane-cmd", description: "a project command", source: "command", template: "Say hi to $ARGUMENTS" },
    { name: "lane-skill", description: "a project skill", source: "skill", template: "Do the lane thing." },
    { name: "reconnect", description: "reconnect this agent to the mesh", source: "command", template: "" },
  ]));
  const oc = standIn("opencode", FAKE, { FAKE_OC1_REPLY: reply });
  const list = (): Promise<CommandCatalog> => opencodeConnector.commands!.list({ cwd: project, resolvedBinaries: { opencode: oc.bin } });
  const catalog = await list().catch((e: Error) => e.message);
  check("opencode 1.x: commands and skills are listed under the targets a seat runs them by, without the launch's own /reconnect", same(catalog, { supported: true, commands: [
    { name: "init", target: "command", description: "guided AGENTS.md setup" },
    { name: "lane-cmd", target: "command", description: "a project command" },
    { name: "lane-skill", target: "skill", description: "a project skill" },
  ] }), catalog);
  const serve = lines(oc.log).find((e) => e.argv?.[0] === "serve");
  const flag = (name: string): string | undefined => serve?.argv[serve.argv.indexOf(name) + 1];
  // 1.x takes port 0 as 4096 while that is free, so a read that asked for 0 could take an operator's server port.
  check("opencode 1.x: it reads a server it starts in the launch's directory, on loopback and a free port, with a password and a database of its own",
    serve?.cwd === project && flag("--hostname") === "127.0.0.1" && /^[1-9]\d*$/.test(flag("--port") ?? "") && serve.password === true && typeof serve.db === "string" && !existsSync(dirname(serve.db)), serve);
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const pids: number[] = Array.isArray(serve?.pids) ? serve.pids : [];
  for (let i = 0; i < 40 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 50));
  check("opencode 1.x: the read stops the server and what it started", pids.length === 2 && !pids.some(alive), pids);
  const early = standIn("opencode", FAKE, { FAKE_OC1_REPLY: reply, FAKE_OC1_EARLY_EXIT: "1" });
  const why = await opencodeConnector.commands!.list({ cwd: project, resolvedBinaries: { opencode: early.bin } }).then(() => "listed", (e: Error) => e.message);
  const orphaned: number[] = lines(early.log).find((e) => e.argv?.[0] === "serve")?.pids?.slice(1) ?? [];
  for (let i = 0; i < 40 && orphaned.some(alive); i++) await new Promise((r) => setTimeout(r, 50));
  check("opencode 1.x: a server that exits before it listens is a failed read, and the process it started is stopped too",
    /exited \(3\) before it listened/.test(why) && orphaned.length === 1 && !orphaned.some(alive), { why, orphaned });
  for (const pid of orphaned.filter(alive)) process.kill(pid, "SIGKILL");
  writeFileSync(reply, JSON.stringify({ data: [] }));
  const failed = await list().then((c) => JSON.stringify(c), (e: Error) => e.message);
  check("opencode 1.x: a server that answers no list is a failed read, never an empty list", /answered \/command with no list/.test(failed), failed);
}

// ---- Codex --------------------------------------------------------------------------------------
{
  const skill = (name: string, enabled: boolean, description: string) => ({ name, description, path: `/x/${name}/SKILL.md`, enabled });
  const entries = codexSkillEntries([skill("review", true, "the repo's review"), skill("review", true, "a user review"), skill("off", false, "disabled"), skill("docs", true, "docs")]);
  check("codex: enabled skills only, and the first of a name, the repo's, is the one listed", same(entries, [
    { name: "review", target: "skill", description: "the repo's review" },
    { name: "docs", target: "skill", description: "docs" },
  ]), entries);
}

// ---- the first command in each launch -----------------------------------------------------------
{
  const FIRST: FirstCommand = { id: "abcdefghijklmnopqrstuvwxyz", target: "command", name: "lane-cmd", args: "hello" };
  const connectors: Connector[] = [claudeConnector, codexConnector, opencodeConnector, piConnector];
  for (const c of connectors) {
    const opts = { space: "catalogs", name: `first-${c.name}`, events: false, workspaceRoot: dir, firstCommand: FIRST };
    let spec: LaunchSpec | undefined;
    try {
      spec = c.buildLaunch(opts);
      const path = spec.env?.COTAL_FIRST_COMMAND_FILE;
      check(`${c.name}: the launch names a launch-artifact file holding the first command`,
        path !== undefined && (spec.artifacts ?? []).some((a) => path.startsWith(a)) && same(JSON.parse(readFileSync(path, "utf8")), FIRST), { path });
    } finally {
      if (spec?.artifacts) discardLaunchArtifacts(spec.artifacts);
    }
    const plain = c.buildLaunch({ ...opts, name: `plain-${c.name}`, firstCommand: undefined });
    check(`${c.name}: a launch with no first command names no file`, plain.env?.COTAL_FIRST_COMMAND_FILE === undefined);
    if (plain.artifacts) discardLaunchArtifacts(plain.artifacts);
  }
  check("every connector that declares commands is covered", connectors.every((c) => c.commands !== undefined));
}

rmSync(dir, { recursive: true, force: true });
finish();
