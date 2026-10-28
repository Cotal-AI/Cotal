/**
 * Codex connector buildLaunch smoke (pure, no broker, no binary): the LaunchOpts → LaunchSpec
 * rendering and every declared fail-loud edge. Run: pnpm smoke:codex-args
 */
import { strict as assert } from "node:assert";
import { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCH_MATERIAL_ENV, readLaunchMaterial, registry } from "@cotal-ai/core";
import { configFromEnv, controlFromEnv } from "@cotal-ai/connector-core";
import { AppServerDriver } from "../src/app-server.js";
import { codexConnector } from "../src/index.js";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const launch = (opts: import("@cotal-ai/core").LaunchOpts) => codexConnector.buildLaunch({ events: false, ...opts });
const throws = (name: string, fn: () => unknown, match: RegExp) => {
  try {
    fn();
  } catch (e) {
    check(name, match.test((e as Error).message), (e as Error).message);
    return;
  }
  assert.fail(`${name} — expected a throw`);
};

const dir = mkdtempSync(join(tmpdir(), "cotal-codexargs-"));
process.env.SUPER_SECRET_LEAK_CANARY = "leak-me";
process.env.OPENAI_API_KEY = "sk-test-canary";
try {
  // Self-registration: importing the package must register the connector under "codex".
  check("self-registers as connector codex", registry.resolve("connector", "codex") === codexConnector);

  // Base launch.
  const base = launch({ space: "s", name: "n" });
  check("host entry launched", base.args.length === 1 && /host/.test(base.args[0]), base.args);
  check("identity env", base.env?.COTAL_SPACE === "s" && base.env?.COTAL_NAME === "n");
  check("control endpoint minted", Boolean(base.control?.path && base.control?.token));
  // The socket PATH rides the env; the TOKEN rides the launch material, so a shell this seat runs
  // cannot pick a control-plane bearer out of its own environment. Both halves are asserted: the
  // absence alone would also pass on a launch that minted no control endpoint at all.
  check(
    "control socket path in env, token NOT in env",
    base.env?.COTAL_CONTROL_SOCKET === base.control?.path && base.env?.COTAL_CONTROL_TOKEN === undefined,
  );
  check(
    "control token recoverable from the launch material, matching the spec",
    controlFromEnv(base.env)?.token === base.control?.token,
  );
  check("codex data root defaults to the launch dir", base.env?.COTAL_CODEX_HOME === process.cwd());
  check("unrelated operator variable is withheld", base.env?.SUPER_SECRET_LEAK_CANARY === undefined);
  check("declared provider key is forwarded", base.env?.OPENAI_API_KEY === "sk-test-canary");
  check("ambient per-session COTAL_* is withheld", base.env?.COTAL_CREDS === undefined && base.env?.COTAL_LIFECYCLE_UID === undefined);

  process.env.COTAL_CODEX_BIN = "/operator/pinned-codex";
  try {
    const pinned = launch({ space: "s", name: "n", resolvedBinaries: { codex: "/boot/resolved-codex" } });
    check(
      "operator COTAL_CODEX_BIN wins over the manager boot fallback",
      pinned.env?.COTAL_CODEX_BIN === "/operator/pinned-codex" && pinned.env?.COTAL_CODEX_RESOLVED_BIN === "/boot/resolved-codex",
      pinned.env,
    );
  } finally {
    delete process.env.COTAL_CODEX_BIN;
  }

  // Workspace root pins the data root.
  const rooted = launch({ space: "s", name: "n", workspaceRoot: dir });
  check("workspaceRoot pins the codex data root", rooted.env?.COTAL_CODEX_HOME === dir);

  // Model + variant flags.
  const modeled = launch({ space: "s", name: "n", model: "gpt-5.6-sol", variant: "high" });
  check("model/variant ride env", modeled.env?.COTAL_MODEL === "gpt-5.6-sol" && modeled.env?.COTAL_VARIANT === "high");

  // Agent file: the launcher resolves its model/variant; the connector renders only what it is given.
  const agentFile = join(dir, "peer.md");
  writeFileSync(agentFile, `---\nname: peer\nmodel: gpt-5.5\nvariant: medium\n---\nYou are peer.\n`);
  const fromFile = launch({ space: "s", name: "peer", configPath: agentFile });
  check(
    "agent file model/variant are not re-read by the connector",
    fromFile.env?.COTAL_MODEL === undefined && fromFile.env?.COTAL_VARIANT === undefined && fromFile.env?.COTAL_AGENT_FILE === agentFile,
  );
  const flagWins = launch({ space: "s", name: "peer", configPath: agentFile, model: "gpt-5.6-sol" });
  check("the --model flag wins over the agent file", flagWins.env?.COTAL_MODEL === "gpt-5.6-sol");

  // Launch options → -c override bag (rendered by the host); key-shape guard.
  const opted = launch({
    space: "s",
    name: "n",
    launchOptions: { approval_policy: '"untrusted"', model_verbosity: '"low"' },
  });
  check(
    "launch options ride COTAL_CODEX_CONFIG verbatim",
    JSON.parse(opted.env?.COTAL_CODEX_CONFIG ?? "{}").approval_policy === '"untrusted"',
    opted.env?.COTAL_CODEX_CONFIG,
  );
  throws(
    "an =-embedding launch-option key is refused",
    () => launch({ space: "s", name: "n", launchOptions: { "a=b": "1" } }),
    /not a valid flag name/,
  );
  throws(
    "a prototype-polluting launch-option key is refused",
    () =>
      launch({
        space: "s",
        name: "n",
        launchOptions: JSON.parse('{"__proto__":"x"}') as Record<string, unknown>,
      }),
    /not a valid flag name/,
  );

  // ACL + capabilities env rail.
  const acl = launch({
    space: "s",
    name: "n",
    subscribe: ["team"],
    allowSubscribe: ["team", "review.>"],
    allowPublish: ["team"],
    capabilities: ["spawn"],
  });
  check(
    "ACL env rail forwarded",
    acl.env?.COTAL_SUBSCRIBE === "team" &&
      acl.env?.COTAL_ALLOW_SUBSCRIBE === "team,review.>" &&
      acl.env?.COTAL_ALLOW_PUBLISH === "team" &&
      acl.env?.COTAL_CAPABILITIES === "spawn",
  );

  // Identity extras.
  const full = launch({
    space: "s",
    name: "n",
    role: "coder",
    id: "UAID",
    lifecycleUid: "lc-1",
    backfillFloor: 42,
    servers: "nats://x:1",
    prompt: "greet the operator",
  });
  check(
    "role/id/lifecycle/prompt forwarded",
    full.env?.COTAL_ROLE === "coder" &&
      full.env?.COTAL_ID === "UAID" &&
      full.env?.COTAL_LIFECYCLE_UID === "lc-1" &&
      full.env?.COTAL_CODEX_PROMPT === "greet the operator",
  );
  check("backfill floor forwarded", full.env?.COTAL_BACKFILL_FLOOR === "42", full.env?.COTAL_BACKFILL_FLOOR);
  // The broker URL is NOT one of them: it rides the launch material, so a suite or a tool this seat
  // runs cannot resolve its "default" broker out of an inherited variable and silently dial ours.
  check(
    "broker URL delivered by launch material, not by env",
    full.env?.COTAL_SERVERS === undefined && configFromEnv(full.env).servers === "nats://x:1",
  );

  // A prompt is trimmed on the way in, and a prompt with no text refuses the launch (never dropped).
  check(
    "prompt is trimmed",
    launch({ space: "s", name: "n", prompt: "  greet  " }).env?.COTAL_CODEX_PROMPT === "greet",
  );
  let emptyPromptRefused = false;
  try {
    launch({ space: "s", name: "n", prompt: "   " });
  } catch (e) {
    emptyPromptRefused = /empty/.test(String((e as Error).message));
  }
  check("an empty prompt refuses the launch", emptyPromptRefused);

  // User-mode auth rail + the one-identity-plane rule.
  const user = launch({
    space: "s",
    name: "n",
    userAuth: { owner: "o", actor: "a", sentinelCredsPath: "/tmp/sc", bearerCmd: ["cmd", "arg"] },
  });
  // Forwarded through the launch material, not the environment: the sentinel creds path and the
  // bearer command are the user-mode equivalent of a credential, and a build script the seat runs
  // has no more business holding them than it has holding a creds file.
  check(
    "user-mode auth rail NOT in the seat env",
    user.env?.COTAL_OWNER === undefined && user.env?.COTAL_ACTOR === undefined && user.env?.COTAL_BEARER_CMD === undefined,
  );
  check("user-mode auth rail forwarded through the launch material", (() => {
    const m = readLaunchMaterial(user.env?.[LAUNCH_MATERIAL_ENV] as string);
    return (
      m.userAuth?.owner === "o" &&
      m.userAuth?.actor === "a" &&
      m.userAuth?.sentinelCredsPath === "/tmp/sc" &&
      m.userAuth?.bearerCmd.join(",") === "cmd,arg"
    );
  })());
  throws(
    "creds + userAuth is refused (one identity plane)",
    () =>
      launch({
        space: "s",
        name: "n",
        creds: "/tmp/creds",
        userAuth: { owner: "o", actor: "a", sentinelCredsPath: "/tmp/sc", bearerCmd: ["c"] },
      }),
    /mutually exclusive/,
  );

  // Declared-unsupported features fail loud.
  throws(
    "resume is refused (a resumed thread has no cotal_* MCP tools)",
    () => launch({ space: "s", name: "n", resume: "0199-abc" }),
    /resum/i,
  );
  throws(
    "the whole mcp_servers namespace is reserved (top-level table, the reachable shape)",
    () => launch({ space: "s", name: "n", launchOptions: { mcp_servers: '{ evil = { url = "http://x" } }' } }),
    /reserved/i,
  );
  throws(
    "tool-sharing is refused",
    () => launch({ space: "s", name: "n", mcpServers: { srv: { command: "x" } } }),
    /tool-sharing/,
  );
  // The TUI/headless choice is derived from the host's own stdout, and COTAL_CODEX_TUI overrides
  // it. The child's env is an ALLOW-LIST, so an override that is not forwarded BY NAME is
  // advertised and unreachable through the one path operators actually use.
  const noTui = launch({ space: "s", name: "n" });
  check("COTAL_CODEX_TUI is absent when the operator did not set it", noTui.env?.COTAL_CODEX_TUI === undefined);
  process.env.COTAL_CODEX_TUI = "0";
  try {
    const forced = launch({ space: "s", name: "n" });
    check("COTAL_CODEX_TUI reaches the host through the env allow-list", forced.env?.COTAL_CODEX_TUI === "0");
  } finally {
    delete process.env.COTAL_CODEX_TUI;
  }
  // What the operator is told to expect on a foreground spawn is the CONNECTOR's to say: another
  // harness's first-run gate named here sends them looking for a prompt that never appears.
  check(
    "a launch hint is declared, and does not promise another harness's prompt",
    typeof codexConnector.launchHint === "string" &&
      codexConnector.launchHint.length > 0 &&
      !/dev-channels/.test(codexConnector.launchHint),
    codexConnector.launchHint,
  );
  check("variant support is declared", codexConnector.supportsModelVariant === true);
  check("resume support is NOT declared (pre-mint preflight)", codexConnector.supportsResume !== true);
  check("requires names the codex binary", Array.isArray(codexConnector.requires) && codexConnector.requires.includes("codex"));

  // listModels + AppServerDriver.stop: child.kill("SIGKILL") is called bare without an empty
  // catch block. Node's ChildProcess.kill returns false on an already-exited or unspawned child
  // and throws only when the signal itself is invalid, which must propagate rather than be swallowed.
  const fakeCatalog = join(dir, "codex-catalog.mjs");
  writeFileSync(
    fakeCatalog,
    `#!${process.execPath}
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === 1) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { userAgent: "fake/0.145.0" } }) + "\\n");
  } else if (msg.id === 2) {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { data: [{ id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4" }] },
    }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`,
  );
  chmodSync(fakeCatalog, 0o755);

  const fakeExitEarly = join(dir, "codex-exit-early.mjs");
  writeFileSync(
    fakeExitEarly,
    `#!${process.execPath}
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
let lines = 0;
rl.on("line", () => {
  if (++lines >= 2) process.exit(0);
});
`,
  );
  chmodSync(fakeExitEarly, 0o755);

  const fakeIgnoreTerm = join(dir, "codex-ignore-term.mjs");
  writeFileSync(
    fakeIgnoreTerm,
    `#!${process.execPath}
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(fileURLToPath(new URL("../package.json", import.meta.url)))});
const { WebSocketServer } = require("ws");
process.on("SIGTERM", () => {});
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
wss.on("listening", () => {
  process.stderr.write("listening on: ws://127.0.0.1:" + wss.address().port + "\\n");
});
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    for (const line of String(raw).split("\\n").filter(Boolean)) {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake/0.145.0" } }) + "\\n");
      } else if (msg.method === "thread/start") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "t-1" }, model: "gpt-5.4" } }) + "\\n");
      } else if (msg.method === "thread/inject_items") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
      }
    }
  });
});
setInterval(() => {}, 1000);
`,
  );
  chmodSync(fakeIgnoreTerm, 0o755);

  const realKill = ChildProcess.prototype.kill;
  const killCalls: { signal: NodeJS.Signals | number | undefined; ret: boolean | null; threw: string | null }[] = [];
  const children: ChildProcess[] = [];
  let forceInvalidSigkill = false;
  ChildProcess.prototype.kill = function (this: ChildProcess, signal?: NodeJS.Signals | number): boolean {
    children.push(this);
    const sig = forceInvalidSigkill && signal === "SIGKILL" ? ("SIGPROBE" as NodeJS.Signals) : signal;
    try {
      const ret = realKill.call(this, sig);
      killCalls.push({ signal, ret, threw: null });
      return ret;
    } catch (e) {
      killCalls.push({ signal, ret: null, threw: (e as NodeJS.ErrnoException).code ?? (e as Error).message });
      throw e;
    }
  };
  try {
    killCalls.length = 0;
    const cat = await codexConnector.listModels!({ resolvedBinaries: { codex: fakeCatalog } });
    check(
      "listModels returns the catalog and kills the live app-server child with SIGKILL",
      cat.models.length === 1 && cat.models[0]?.id === "gpt-5.4" && killCalls.at(-1)?.signal === "SIGKILL" && killCalls.at(-1)?.ret === true,
      killCalls,
    );

    killCalls.length = 0;
    let earlyErr = "";
    try {
      await codexConnector.listModels!({ resolvedBinaries: { codex: fakeExitEarly } });
    } catch (e) {
      earlyErr = (e as Error).message;
    }
    check(
      "listModels on an already-exited child calls SIGKILL bare (returns false without throwing)",
      /exited \(0\) before model\/list answered/.test(earlyErr) &&
        killCalls.at(-1)?.signal === "SIGKILL" &&
        killCalls.at(-1)?.ret === false &&
        killCalls.at(-1)?.threw === null,
      { earlyErr, killCalls },
    );

    killCalls.length = 0;
    let enoentCode = "";
    try {
      await codexConnector.listModels!({ resolvedBinaries: { codex: join(dir, "missing-codex") } });
    } catch (e) {
      enoentCode = (e as NodeJS.ErrnoException).code ?? "";
    }
    check(
      "listModels on an unspawned child (ENOENT) calls SIGKILL bare (returns false without throwing)",
      enoentCode === "ENOENT" &&
        killCalls.at(-1)?.signal === "SIGKILL" &&
        killCalls.at(-1)?.ret === false &&
        killCalls.at(-1)?.threw === null,
      { enoentCode, killCalls },
    );

    killCalls.length = 0;
    forceInvalidSigkill = true;
    let invalidSigCode = "";
    try {
      await codexConnector.listModels!({ resolvedBinaries: { codex: fakeCatalog } });
    } catch (e) {
      invalidSigCode = (e as NodeJS.ErrnoException).code ?? "";
    } finally {
      forceInvalidSigkill = false;
      for (const c of children) realKill.call(c, "SIGKILL");
    }
    check(
      "listModels does not swallow a kill throw in finally",
      invalidSigCode === "ERR_UNKNOWN_SIGNAL",
      { invalidSigCode, killCalls },
    );

    killCalls.length = 0;
    const stopHome1 = join(dir, "stop-home-1");
    mkdirSync(stopHome1, { recursive: true });
    const driver1 = new AppServerDriver({ cwd: dir, codexHome: stopHome1, configOverrides: [], bin: fakeIgnoreTerm, log: () => {} });
    await driver1.start();
    await driver1.stop();
    check(
      "AppServerDriver.stop escalates from SIGTERM to SIGKILL when the child ignores SIGTERM",
      killCalls.length === 2 &&
        killCalls[0]?.signal === "SIGTERM" &&
        killCalls[1]?.signal === "SIGKILL" &&
        killCalls[1]?.ret === true &&
        killCalls[1]?.threw === null,
      killCalls,
    );

    const stopHome2 = join(dir, "stop-home-2");
    mkdirSync(stopHome2, { recursive: true });
    const driver2 = new AppServerDriver({ cwd: dir, codexHome: stopHome2, configOverrides: [], bin: fakeIgnoreTerm, log: () => {} });
    await driver2.start();
    let stopEscalationThrow = "";
    const onUncaught = (e: Error): void => {
      stopEscalationThrow = (e as NodeJS.ErrnoException).code ?? e.message;
      const last = children.at(-1);
      if (last) realKill.call(last, "SIGKILL");
    };
    process.once("uncaughtException", onUncaught);
    forceInvalidSigkill = true;
    try {
      await driver2.stop();
    } finally {
      forceInvalidSigkill = false;
      process.removeListener("uncaughtException", onUncaught);
      for (const c of children) realKill.call(c, "SIGKILL");
    }
    check(
      "AppServerDriver.stop escalation does not swallow a kill throw",
      stopEscalationThrow === "ERR_UNKNOWN_SIGNAL",
      stopEscalationThrow,
    );
  } finally {
    ChildProcess.prototype.kill = realKill;
    for (const c of children) realKill.call(c, "SIGKILL");
  }

  console.log(`\n${pass} checks passed`);
} finally {
  delete process.env.SUPER_SECRET_LEAK_CANARY;
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
