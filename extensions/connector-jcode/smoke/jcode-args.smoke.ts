import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCH_MATERIAL_ENV, readLaunchMaterial, registry } from "@cotal-ai/core";
import { configFromEnv, controlFromEnv, cotalToolSpecs, EventWal } from "@cotal-ai/connector-core";
import { z } from "zod";
import { jcodeConnector, listJcodeModels, JCODE_READINESS_TIMEOUT_MS } from "../src/index.js";
import { createJcodeMapper } from "../src/agui-map.js";
/** The unit a record mapped to, or `null`: a turn the mapper opens no run for maps to none. */
const unitOf = <U extends { runId: string }>(r: U | { turn: true } | null): U | null => (r !== null && "runId" in r ? r : null);
import { initializeJcodeEventBoundary, JcodeJournalSource } from "../src/agui-source.js";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  try {
    assert.ok(condition, `${name}${actual === undefined ? "" : `: ${JSON.stringify(actual)}`}`);
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
};
const launch = (opts: import("@cotal-ai/core").LaunchOpts) => jcodeConnector.buildLaunch({ events: false, ...opts });
const throws = (name: string, fn: () => unknown, match: RegExp): void => {
  try {
    assert.throws(fn, match, name);
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), "cotal-jcodeargs-"));
process.env.UNRELATED_JCODE_ENV_CANARY = "inherited";
try {
  let registered = false;
  try {
    registered = registry.resolve("connector", "jcode") === jcodeConnector;
  } catch {
    // Keep the assertion's named failure visible: a missing registration otherwise throws before
    // check() can print its label, which makes mutation-proof correctly call it an unrelated red.
  }
  check("self-registers as connector jcode", registered);
  if (process.platform === "win32") {
    // The refusal below is the FIRST buildLaunch on this platform: every later probe in this file
    // assumes a Unix host, so the Windows arm must run before any of them can throw unlabelled.
    throws("refuses unsupported Windows host", () => launch({ space: "s", name: "n" }), /not supported on Windows/);
    console.log(`\nJCODE ARGS SMOKE PASSED (${pass} checks)`);
    process.exit(0);
  }
  const base = launch({ space: "space", name: "seat", events: false });
  check(
    "starts the host directly in Node with the source loader",
    base.command === process.execPath && base.args.length === 3 && base.args[0] === "--import" && base.args[1] === import.meta.resolve("tsx") && /host-main\.ts$/.test(base.args[2]),
    { command: base.command, args: base.args },
  );
  check("requires the jcode binary", jcodeConnector.requires?.join(",") === "jcode");
  check("declares a bounded three-minute bootstrap window", jcodeConnector.readinessTimeoutMs === JCODE_READINESS_TIMEOUT_MS && JCODE_READINESS_TIMEOUT_MS === 180_000, jcodeConnector.readinessTimeoutMs);
  const here = dirname(fileURLToPath(import.meta.url));
  const extensionSrc = readFileSync(join(here, "../src/extension.ts"), "utf8");
  const hostSrc = readFileSync(join(here, "../src/host.ts"), "utf8");
  const hostSupportSrc = readFileSync(join(here, "../src/host-support.ts"), "utf8");
  check(
    "the manager window is the exported bound, not a second literal",
    /readinessTimeoutMs:\s*JCODE_READINESS_TIMEOUT_MS/.test(extensionSrc) && !/\b180_000\b/.test(extensionSrc),
    extensionSrc.match(/readinessTimeoutMs[\s\S]{0,80}/)?.[0],
  );
  check(
    "the host default bound is that same export, not a second literal",
    /return JCODE_READINESS_TIMEOUT_MS/.test(hostSupportSrc) && !/\b180_000\b/.test(hostSrc + hostSupportSrc),
    hostSupportSrc.match(/readinessTurnTimeoutMs[\s\S]{0,200}/)?.[0],
  );
  check("feeds the jcode binary's catalog into the connector hook", jcodeConnector.listModels === listJcodeModels);
  // Stand-ins for the jcode binary, each a script that records how it was run. The recording is a
  // real `jcode model list --json` from jcode 0.99.1 with two named OpenAI-compatible profiles.
  const recording = join(here, "fixtures/jcode-model-list.json");
  const fakeJcode = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\necho "$*" > '${path}.argv'\nenv > '${path}.env'\n${body}\n`, { mode: 0o700 });
    return path;
  };
  const listFrom = (bin: string) => listJcodeModels({ resolvedBinaries: { jcode: bin } });
  const rejection = async (catalog: Promise<unknown>): Promise<string> => catalog.then(() => "", (error: Error) => error.message);
  const listing = fakeJcode("jcode-lists", `cat '${recording}'`);
  const catalog = await listFrom(listing);
  const byId = new Map(catalog.models.map((model) => [model.id, model]));
  check("runs the binary a spawn will run as `jcode model list --json --no-update`", readFileSync(`${listing}.argv`, "utf8").trim() === "model list --json --no-update");
  const listingEnv = readFileSync(`${listing}.env`, "utf8");
  check("runs jcode in the environment a seat's host gets", listingEnv.includes(`HOME=${process.env.HOME}\n`) && !listingEnv.includes("UNRELATED_JCODE_ENV_CANARY"));
  check("names the binary as the catalog source", catalog.source === "jcode model list --json", catalog.source);
  check(
    "lists every model jcode reports with an available route, in jcode's order",
    catalog.models.length === 183 && catalog.models.slice(0, 3).map((model) => model.id).join(",") === "gpt-5.6-pro[web],minimax-m2.7,kimi-k2.5",
    catalog.models.slice(0, 3),
  );
  check("drops a model whose every route jcode reports unavailable", !byId.has("claude-opus-5-5") && !byId.has("gpt-6.1-sol"));
  check("attributes a model to jcode's selected provider when that provider carries it", byId.get("gpt-5.4")?.provider === "fakeprov", byId.get("gpt-5.4"));
  check("attributes a model to the only provider that carries it", byId.get("fake-gamma")?.provider === "fakeprov2", byId.get("fake-gamma"));
  check("leaves a model unattributed when several other providers carry it", byId.has("glm-4.7") && byId.get("glm-4.7")?.provider === undefined, byId.get("glm-4.7"));
  check("offers no effort variants, because jcode reports none per model", catalog.models.every((model) => model.variants === undefined));
  const loggedOut = fakeJcode("jcode-logged-out", `cat > /dev/null\necho "No credentials found. Let's log in!" >&2\necho "Error: Login skipped. Run \\\`jcode login\\\` when you're ready to authenticate." >&2\nexit 1`);
  const loggedOutMessage = await rejection(listFrom(loggedOut));
  check(
    "ends stdin so jcode's login prompt exits, and names jcode's own reason",
    loggedOutMessage === "jcode model list failed: Error: Login skipped. Run `jcode login` when you're ready to authenticate.",
    loggedOutMessage,
  );
  const unexpected = await rejection(listFrom(fakeJcode("jcode-unexpected", `echo '{"provider":"p","models":"m","routes":[]}'`)));
  check("refuses output that is not jcode's model list", unexpected === "jcode model list --json printed an unexpected shape", unexpected);
  check("forwards mesh identity", base.env?.COTAL_SPACE === "space" && base.env?.COTAL_NAME === "seat");
  check("pins private state to the launch directory", base.env?.COTAL_JCODE_HOME === process.cwd());
  check("drops ordinary operator env unless explicitly allowed", base.env?.UNRELATED_JCODE_ENV_CANARY === undefined);
  const allowed = launch({ space: "space", name: "seat", envAllow: ["UNRELATED_JCODE_ENV_CANARY"], events: false });
  check("inherits explicitly allowed operator env", allowed.env?.UNRELATED_JCODE_ENV_CANARY === "inherited");
  check("resets inherited Cotal material", base.env?.COTAL_CREDS === undefined && base.env?.COTAL_LIFECYCLE_UID === undefined);
  check("mints a manager control endpoint", Boolean(base.control?.path && base.control?.token));
  check("keeps the control token out of the environment", base.env?.COTAL_CONTROL_KEY === undefined);
  check("control token round-trips through launch material", controlFromEnv(base.env)?.token === base.control?.token);

  const rooted = launch({ space: "space", name: "seat", workspaceRoot: dir, events: undefined });
  check("workspaceRoot pins private state", rooted.env?.COTAL_JCODE_HOME === dir);
  check("declares the shared AG-UI event channel", jcodeConnector.eventChannel?.({ owner: "owner", actor: "actor" }) === "events.owner.actor");
  check("ordinary launches arm the event plane", rooted.env?.COTAL_EVENTS === "1" && rooted.env?.COTAL_WORKSPACE_ROOT === dir);
  const optedOut = launch({ space: "space", name: "seat", workspaceRoot: dir, events: false });
  check("--no-events leaves the event plane off", optedOut.env?.COTAL_EVENTS === undefined && optedOut.env?.COTAL_WORKSPACE_ROOT === undefined);
  const evented = launch({ space: "space", name: "seat", workspaceRoot: dir, events: true });
  check(
    "event launches arm the plane and pin its durable root",
    evented.env?.COTAL_EVENTS === "1" && evented.env?.COTAL_WORKSPACE_ROOT === dir,
    evented.env,
  );
  throws("events require a durable workspace root", () => launch({ space: "s", name: "n", events: true }), /workspace root/);
  check("Jcode TUI override is absent when unset", base.env?.COTAL_JCODE_TUI === undefined);
  process.env.COTAL_JCODE_TUI = "0";
  try {
    check("Jcode TUI override crosses the launch boundary", launch({ space: "s", name: "n", events: false }).env?.COTAL_JCODE_TUI === "0");
  } finally {
    delete process.env.COTAL_JCODE_TUI;
  }

  const full = launch({
    space: "space",
    name: "seat",
    role: "worker",
    id: "ID",
    lifecycleUid: "life",
    backfillFloor: 42,
    servers: "nats://bridge.test:4222",
    model: "gpt-5.6-sol",
    prompt: "  do the thing  ",
    events: false,
  });
  check(
    "forwards identity/model/prompt",
    full.env?.COTAL_ROLE === "worker" &&
      full.env?.COTAL_ID === "ID" &&
      full.env?.COTAL_LIFECYCLE_UID === "life" &&
      full.env?.COTAL_MODEL === "gpt-5.6-sol" &&
      full.env?.COTAL_JCODE_PROMPT === "do the thing",
    full.env,
  );
  check("backfill floor forwarded", full.env?.COTAL_BACKFILL_FLOOR === "42", full.env?.COTAL_BACKFILL_FLOOR);
  check("keeps broker URL out of env", full.env?.COTAL_SERVERS === undefined);
  check("broker URL resolves from material", configFromEnv(full.env).servers === "nats://bridge.test:4222");
  check("material preserves static creds when supplied", (() => {
    const withCreds = launch({ space: "s", name: "n", creds: "/tmp/seat.creds", events: false });
    return readLaunchMaterial(withCreds.env?.[LAUNCH_MATERIAL_ENV] ?? "").creds === "/tmp/seat.creds";
  })());

  const persona = join(dir, "agent.md");
  writeFileSync(persona, "---\nname: seat\nmodel: from-file\nvariant: medium\n---\nPersona\n");
  check("does not re-read the agent-file model", launch({ space: "s", name: "seat", configPath: persona, events: false }).env?.COTAL_MODEL === undefined);
  check("explicit model wins over agent file", launch({ space: "s", name: "seat", configPath: persona, model: "flag", events: false }).env?.COTAL_MODEL === "flag");

  // The variant IS Jcode's per-session reasoning effort. The connector carries the requested tier
  // verbatim; the tier is validated at launch by the provider that owns the ladder (the host calls
  // set_reasoning_effort and lets Jcode refuse), so nothing here re-implements that catalog.
  check("variant support is declared", jcodeConnector.supportsModelVariant === true);
  const tiered = launch({ space: "space", name: "seat", model: "gpt-5.6-sol", variant: "xhigh", events: false });
  check("variant rides env as the reasoning effort", tiered.env?.COTAL_VARIANT === "xhigh", tiered.env);
  check("variant reaches the host config seam", configFromEnv(tiered.env).variant === "xhigh");
  check("variant is absent when unrequested", base.env?.COTAL_VARIANT === undefined);
  check("does not re-read the agent-file variant", launch({ space: "s", name: "seat", configPath: persona, events: false }).env?.COTAL_VARIANT === undefined);
  check("explicit variant wins over agent file", launch({ space: "s", name: "seat", configPath: persona, variant: "max", events: false }).env?.COTAL_VARIANT === "max");

  // Jcode decorates its MCP calls with these two harness fields. The bridge extends only the
  // advertised host schema and strips them before relaying; arbitrary Cotal inputs remain closed.
  const hostSchema = cotalToolSpecs(configFromEnv(full.env), "jcode").find((spec) => spec.name === "cotal_dm")!.schema
    .extend({ accept_large_output: z.boolean().optional(), intent: z.string().optional() }).strict();
  check("Jcode MCP decoration is accepted by the host-facing schema", hostSchema.safeParse({ to: "operator", text: "PONG", accept_large_output: false, intent: "reply" }).success);
  check("Jcode MCP schema still refuses non-harness extras", !hostSchema.safeParse({ to: "operator", text: "PONG", owner: "forged" }).success);

  throws("refuses empty prompt", () => launch({ space: "s", name: "n", prompt: "  " }), /empty/);
  throws("refuses resume of a session with no readable transcript", () => launch({ space: "s", name: "n", resume: "old" }), /cannot resume session old: no readable transcript/);
  throws("refuses exact-session continuation", () => launch({ space: "s", name: "n", continueSession: "old" }), /continuation/);
  throws("refuses tool sharing", () => launch({ space: "s", name: "n", mcpServers: { extra: { command: "x" } } }), /tool-sharing/);
  throws("refuses unsupported launch options", () => launch({ space: "s", name: "n", launchOptions: { profile: "full" } }), /launch options are not supported/);
  throws("still validates malformed launch option keys", () => launch({ space: "s", name: "n", launchOptions: { "a=b": "x" } }), /not a valid flag name/);

  const mapperRecord = {
    cursor: "journal:cursor:1",
    record: { append_messages: [
      {
        role: "assistant",
        timestamp: "2026-09-22T00:00:00.000Z",
        content: [
          { type: "reasoning", text: "why" },
          { type: "tool_use", id: "call-1", name: "bash", input: { command: "printf ok" } },
          { type: "text", text: "done" },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] },
    ] },
  };
  const mapper = createJcodeMapper({ threadId: "session-1", mintRunId: () => "run-1", now: () => 7 });
  const mapped = unitOf(mapper.map(mapperRecord));
  check(
    "maps durable Jcode message blocks into one native AG-UI run",
    mapped?.runId === "run-1" &&
      mapped.events.map((event) => event.type).join(",") ===
        "RUN_STARTED,REASONING_MESSAGE_START,REASONING_MESSAGE_CONTENT,REASONING_MESSAGE_END,TOOL_CALL_START,TOOL_CALL_ARGS,TEXT_MESSAGE_START,TEXT_MESSAGE_CONTENT,TEXT_MESSAGE_END,TOOL_CALL_END,TOOL_CALL_RESULT,CUSTOM",
    mapped,
  );
  mapper.forgetOpenRun("run-1");
  check(
    "a closed Jcode run opens a fresh run for later durable output",
    unitOf(mapper.map({ cursor: "journal:cursor:2", record: { append_messages: [{ role: "assistant", content: [{ type: "text", text: "next" }] }] } }))?.events[0]?.type === "RUN_STARTED",
  );
  const restartedMapped = unitOf(createJcodeMapper({ threadId: "session-1", mintRunId: () => "run-2", now: () => 8 }).map(mapperRecord));
  const messageIds = (result: typeof mapped) => result?.events.flatMap((event) => "messageId" in event ? [event.messageId] : []) ?? [];
  check(
    "durable Jcode record positions keep message ids stable across mapper restarts",
    JSON.stringify(messageIds(restartedMapped)) === JSON.stringify(messageIds(mapped)),
    { first: messageIds(mapped), restarted: messageIds(restartedMapped) },
  );

  const journal = join(dir, "restart.journal.jsonl"), walPath = join(dir, "restart.wal.json");
  writeFileSync(journal, `${JSON.stringify({ append_messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "orientation-1", name: "cotal_orientation" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "orientation-1", content: "ready" }] },
  ] })}\n`);
  const wal = await EventWal.open(walPath, { space: "space", threadId: "session-restart", principal: "owner:actor", subjectMayExist: false });
  const boundary = await initializeJcodeEventBoundary(journal, wal);
  appendFileSync(journal, `${JSON.stringify({ append_messages: [{ role: "assistant", content: [{ type: "text", text: "requested answer" }] }] })}\n`);
  const restartedWal = await EventWal.open(walPath, { space: "space", threadId: "session-restart", principal: "owner:actor", subjectMayExist: false });
  const acknowledged = await initializeJcodeEventBoundary(journal, restartedWal);
  const source = new JcodeJournalSource(journal);
  const recovered = await source.read(acknowledged);
  const restartFrames = recovered.records.flatMap((record) =>
    unitOf(createJcodeMapper({ threadId: "session-restart", mintRunId: () => "run-requested", now: () => 9 })
      .map({ cursor: record.cursor, record: record.value }))?.events.map((event) => event.type) ?? []
  );
  check(
    "the persisted Jcode boundary excludes readiness and replays a post-boundary record after restart",
    acknowledged === boundary &&
      recovered.records.length === 1 &&
      recovered.records[0]?.value.append_messages?.[0]?.content?.[0]?.text === "requested answer" &&
      restartFrames.join(",") === "RUN_STARTED,TEXT_MESSAGE_START,TEXT_MESSAGE_CONTENT,TEXT_MESSAGE_END" &&
      hostSrc.includes("if (!readinessTurnOpen) await ensureEventsBound();"),
    { boundary, acknowledged, recovered, restartFrames },
  );

  console.log(`\nJCODE ARGS SMOKE PASSED: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
} finally {
  delete process.env.UNRELATED_JCODE_ENV_CANARY;
  rmSync(dir, { recursive: true, force: true });
}
