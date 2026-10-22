/** Intended native CLI acceptance, opt-in because it uses real inference. No login cache is read
 * or copied by the fixture. Only the isolated mesh and finite sleep commands are exposed. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CotalEndpoint, CotalMessage, Delivery } from "@cotal-ai/core";

export async function runPersonalNativeAcceptance(input: {
  home: string; cwd: string; cli: string[]; sender: CotalEndpoint;
  peer: { roster(): Array<{ card: { id?: string; name: string } }> };
  env: NodeJS.ProcessEnv;
  /** The fixture person approves the connection `name` asked for, once it is waiting. */
  approve(name: string): Promise<void>;
  evidence?: string;
  transitionRace?: boolean;
  longBoundary?: boolean;
  traceInline?: boolean;
  onConnected?(principal: string, session: string): Promise<void>;
}): Promise<{ principal: string; markers: string[]; stdout: string }> {
  const session = randomUUID();
  const fixture = join(input.home, `native-runtime-${session}`);
  const plugin = join(fixture, "plugin");
  const source = resolve(import.meta.dirname, "../../../extensions/connector-claude-code");
  for (const dir of [fixture, plugin, join(plugin, "hooks"), join(plugin, "dist"), join(plugin, ".claude-plugin")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const file of [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/native-wake.js", "dist/mcp.cjs", "dist/hook.cjs", "dist/monitor.cjs"])
    copyFileSync(join(source, file), join(plugin, file));
  writeFileSync(join(plugin, "dist/cli.json"), JSON.stringify({ argv: input.cli }), { mode: 0o600 });
  const deliveredFiles = ["hooks/native-wake.js", "dist/mcp.cjs", "dist/hook.cjs", "dist/monitor.cjs"];
  const productHashes = Object.fromEntries(deliveredFiles.map((file) => [file, createHash("sha256").update(readFileSync(join(plugin, file))).digest("hex")]));
  if (input.transitionRace) {
    const module = join(plugin, "hooks/native-wake.js");
    const text = readFileSync(module, "utf8");
    const marker = "  const claim = await receipt($, frame, 'claim');";
    assert.equal(text.split(marker).length, 2, "the fixture instruments one claim boundary without changing delivery logic");
    writeFileSync(module, text.replace(marker, `  $.ui.log('NATIVE_CLAIM_STARTED');\n${marker}`));
    const helper = join(plugin, "dist/monitor.cjs");
    writeFileSync(helper, `if(process.argv.includes('--native-delivery')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);\n${readFileSync(helper, "utf8")}`);
  }
  if (input.traceInline) {
    const module = join(plugin, "hooks/native-wake.js");
    let text = readFileSync(module, "utf8");
    const trace = (anchor: string, replacement: string) => {
      assert.equal(text.split(anchor).length, 2, `trace anchor must be unique: ${anchor}`);
      text = text.replace(anchor, replacement);
    };
    trace("  const result = await $.process.run(\n", "  $.ui.log('INLINE_RECEIPT_START ' + action);\n  const result = await $.process.run(\n");
    trace("  return JSON.parse(result.stdout);", "  $.ui.log('INLINE_RECEIPT_END ' + action + ' ' + result.exitCode + ' ' + String(JSON.parse(result.stdout).ok));\n  return JSON.parse(result.stdout);");
    trace("  if (submitting || paused || active !== inTurn) return;", "  $.ui.log('INLINE_SUBMIT ' + JSON.stringify({submitting,paused,active,inTurn,offers:offers.size}));\n  if (submitting || paused || active !== inTurn) return;");
    trace("    reader = $.process.spawn(", "    $.ui.log('INLINE_READER_START');\n    reader = $.process.spawn(");
    trace("    active = false;", "    active = false;\n    $.ui.log('INLINE_COMPLETE ' + JSON.stringify({aborted:e.isAborted,paused,submitting,offers:offers.size}));");
    trace("      if (matches.length === 1) {", "      $.ui.log('INLINE_STORED_MATCHES ' + matches.length);\n      if (matches.length === 1) {");
    writeFileSync(module, text);
  }
  const name = `native_real_${session.slice(0, 8)}`;
  const env: NodeJS.ProcessEnv = { ...input.env, CLAUDE_CONFIG_DIR: join(fixture, "config") };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const mcp = { mcpServers: { cotal: { command: process.execPath, args: [join(plugin, "dist/mcp.cjs")] } } };
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-5-5",
    "--session-id", session, "--plugin-dir", plugin, "--setting-sources", "", "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp),
    "--permission-mode", "dontAsk", "--tools", "Bash", "--allowedTools", "mcp__cotal__*", "Bash(sleep *)"];
  const out = openSync(join(fixture, "native-stdout.jsonl"), "wx", 0o600);
  const err = openSync(join(fixture, "native-stderr.log"), "wx", 0o600);
  const child = spawn("claude", args, { cwd: input.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  const rows: Array<{ sequence: number; value: any }> = [];
  const texts: Array<{ sequence: number; text: string }> = [];
  let buffer = "", sequence = 0;
  let nativePrincipal: string | undefined;
  const receivedReplies: Array<{ sequence: number; message: CotalMessage }> = [];
  const receiveReply = (message: CotalMessage, delivery: Delivery) => {
    if (message.from.id !== nativePrincipal) return;
    receivedReplies.push({ sequence, message });
    delivery.ack();
  };
  input.sender.on("message", receiveReply);
  child.stdout.on("data", (piece: Buffer) => {
    writeFileSync(out, piece);
    buffer += piece.toString();
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const value = JSON.parse(line);
        const seq = ++sequence;
        rows.push({ sequence: seq, value });
        if (value.type === "assistant") for (const part of value.message?.content ?? []) if (part.type === "text") texts.push({ sequence: seq, text: part.text });
        if (value.type === "result" && typeof value.result === "string") texts.push({ sequence: seq, text: value.result });
      } catch {}
    }
  });
  child.stderr.on("data", (piece: Buffer) => writeFileSync(err, piece));
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const until = async (condition: () => boolean, label: string, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (condition()) return;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`native acceptance exited before ${label}; private logs retained`);
      await wait(100);
    }
    throw new Error(`native acceptance timed out waiting for ${label}; private logs retained`);
  };
  const prompt = (text: string) => child.stdin.write(JSON.stringify({ type: "user", session_id: session, parent_tool_use_id: null, message: { role: "user", content: text } }) + "\n");
  const assistantSaid = (marker: string, since = 0) => texts.some((row) => row.sequence > since && row.text.includes(marker));
  const answered = (marker: string, since = 0) => assistantSaid(marker, since) || receivedReplies.some((row) =>
    row.sequence >= since && row.message.parts.some((part) => part.kind === "text" && part.text.includes(marker)));
  const toolCalls = (tool: string, since = 0) => rows.flatMap((row) => row.sequence > since && row.value.type === "assistant"
    ? (row.value.message?.content ?? []).filter((part: any) => part.type === "tool_use" && part.name === tool).map((part: any) => ({ sequence: row.sequence, input: part.input })) : []);
  const passed: string[] = [];
  const markers: string[] = [];
  try {
    prompt(`This is an isolated Cotal native acceptance test. Call mcp__cotal__cotal_connect with name ${name}. If it says the person must approve, reply APPROVAL_PENDING and stop. Do not call cotal_wait. Once connected, reply READY_NATIVE and its connection_id. A Cotal inline delivery contains the complete message: follow it without calling cotal_inbox. Only notification-only or explicitly incomplete deliveries require an inbox read using your own connection_id. Never inspect environment variables or login files.`);
    await until(() => assistantSaid("APPROVAL_PENDING") && rows.some((row) => row.value.type === "result"), "the native model reporting the pending approval");
    assert(rows.some((row) => row.value.type === "user" && JSON.stringify(row.value).includes("Permission approval required")), "cotal_connect did not answer that the person must approve");
    assert(!input.peer.roster().some((row) => row.card.name === name), "the native conversation joined before the person approved it");
    await input.approve(name);
    const approvedAt = sequence;
    prompt(`The person approved this connection in Cotal. Call mcp__cotal__cotal_connect again with name ${name}, then reply READY_NATIVE and its connection_id.`);
    await until(() => assistantSaid("READY_NATIVE", approvedAt) && input.peer.roster().some((row) => row.card.name === name), "native connect");
    passed.push("native-connect-waits-for-the-person");
    const native = input.peer.roster().find((row) => row.card.name === name)!;
    assert(native.card.id, "native connection has no actual principal");
    nativePrincipal = native.card.id;
    if (input.onConnected) await input.onConnected(nativePrincipal, session);
    const idle = `NATIVE_IDLE_ACK_${randomUUID().replaceAll("-", "")}`;
    markers.push(idle);
    const idleAt = sequence;
    await input.sender.unicast(native.card.id, `Reply with ${idle} after reading this message.`);
    if (input.transitionRace) {
      await until(() => rows.some((row) => row.sequence > idleAt && row.value.subtype === "ui_log" && row.value.text === "NATIVE_CLAIM_STARTED"), "native claim before turn-state race");
      prompt("Run Bash sleep 3, then output TRANSITION_WORK_FINISHED. Handle incoming complete Cotal messages at a safe boundary without an inbox call.");
      await until(() => answered(idle, idleAt) || rows.some((row) => row.sequence > idleAt && row.value.subtype === "ui_log" && row.value.text?.includes("delivery is paused")), "transition delivery or incorrect pause", 20_000);
      assert(!rows.some((row) => row.sequence > idleAt && row.value.subtype === "ui_log" && row.value.text?.includes("delivery is paused")), "a main-turn state change during claim must not pause native delivery");
      passed.push("claim-turn-state-change-does-not-pause");
    }
    await until(() => answered(idle, idleAt), "actual idle wake and inbox receipt");
    assert.equal(toolCalls("mcp__cotal__cotal_inbox", idleAt).length, 0, "complete idle delivery needs no inbox call");
    passed.push("native-signed-in-connect-and-idle-inline-dm");
    console.log("  ✓ intended native CLI connects and handles a complete idle DM without an inbox call");
    const second = `NATIVE_SECOND_ACK_${randomUUID().replaceAll("-", "")}`;
    markers.push(second);
    const secondAt = sequence;
    await input.sender.unicast(native.card.id, `Reply with ${second}. Do not call cotal_inbox for this complete inline message.`);
    await until(() => answered(second, secondAt), "second inline wake after automatic drain");
    assert.equal(toolCalls("mcp__cotal__cotal_inbox", secondAt).length, 0);
    passed.push("second-inline-delivery-rearms-without-inbox");
    const contextsAt = sequence;
    const contextMarkers = [0, 1].map(() => `NATIVE_CONTEXT_ACK_${randomUUID().replaceAll("-", "")}`);
    markers.push(...contextMarkers);
    const requests = await Promise.all(contextMarkers.map((marker) => input.sender.unicast(native.card.id!,
      `Send a DM back to fixture_sender containing ${marker}, with replyTo set to this message_id. Then output ${marker}.`,
      { contextId: randomUUID() })));
    await until(() => requests.every((request, index) => receivedReplies.some((row) => row.message.replyTo === request.id &&
      row.message.contextId === request.contextId && row.message.parts.some((part) => part.kind === "text" && part.text.includes(contextMarkers[index]!)))),
      "two actual DM replies with distinct wire contexts");
    assert.equal(toolCalls("mcp__cotal__cotal_inbox", contextsAt).length, 0);
    passed.push("inline-replies-preserve-two-peer-contexts");
    const busyAt = sequence;
    prompt((input.longBoundary
      ? "Run Bash sleep 35 first, then Bash sleep 3 five times, all sequentially. "
      : "Run Bash with command sleep 3 six times sequentially, never in parallel or combined. ") +
      "Between tools, immediately act on complete inline Cotal messages and output the requested marker before continuing the remaining sleeps. Do not fetch complete inline messages again with cotal_inbox. Begin with BUSY_NATIVE_STARTED and end with BUSY_NATIVE_FINISHED after all six sleeps.");
    await until(() => toolCalls("Bash", busyAt).length >= 1, "first deliberately unfinished native tool");
    const busyMarker = `NATIVE_BUSY_ACK_${randomUUID().replaceAll("-", "")}`;
    markers.push(busyMarker);
    const busyDeliveredAt = sequence;
    await input.sender.unicast(native.card.id, `Output ${busyMarker} now, while your sleep sequence is still unfinished. Then finish your remaining work.`);
    await until(() => answered(busyMarker, busyDeliveredAt), "actual busy-boundary wake");
    assert(!assistantSaid("BUSY_NATIVE_FINISHED", busyAt), "busy message was postponed until the original work finished");
    assert.equal(toolCalls("mcp__cotal__cotal_inbox", busyDeliveredAt).length, 0, "complete busy delivery needs no inbox call");
    passed.push("busy-dm-before-original-turn-finished");
    if (input.longBoundary) passed.push("inline-offer-survives-a-35-second-tool-boundary");
    console.log("  ✓ a real DM reaches the native model before its unfinished multi-step turn ends");
    await until(() => assistantSaid("BUSY_NATIVE_FINISHED", busyAt), "completion of the original native work");
    const longAt = sequence;
    const longMarker = `NATIVE_LONG_ACK_${randomUUID().replaceAll("-", "")}`;
    markers.push(longMarker);
    await input.sender.unicast(native.card.id, `This message deliberately exceeds inline size. ${"Long-message fixture content. ".repeat(100)}\nRead through the inbox, then output ${longMarker}.`);
    await until(() => answered(longMarker, longAt), "long message read through inbox");
    assert(toolCalls("mcp__cotal__cotal_inbox", longAt).length > 0, "oversized messages remain queued until an actual inbox read");
    passed.push("oversized-message-keeps-inbox-path");
    const stopAt = sequence;
    prompt("Run sleep 10 using Bash, then reply STOP_TEST_FINISHED. Do not start any other work yet.");
    await until(() => toolCalls("Bash", stopAt).length > 0, "native stop fixture tool");
    child.stdin.write(JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } }) + "\n");
    await until(() => rows.some((row) => row.sequence > stopAt && row.value.type === "control_response"), "native interruption acknowledgement");
    const stoppedAt = sequence;
    const stopMarker = `NATIVE_AFTER_STOP_ACK_${randomUUID().replaceAll("-", "")}`;
    markers.push(stopMarker);
    await input.sender.unicast(native.card.id, `After the person resumes you, output ${stopMarker}.`);
    await wait(3_000);
    assert(!answered(stopMarker, stoppedAt), "peer mail restarted a genuinely interrupted native session");
    prompt("Resume now. Handle the waiting Cotal message and output its requested test marker. Complete inline deliveries do not need another inbox read.");
    await until(() => answered(stopMarker, stoppedAt), "retained mail after genuine test input");
    passed.push("explicit-interrupt-and-genuine-input-resume");
    console.log("  ✓ explicit native interruption retains mail without autonomous restart, then resumes on input");
    prompt("Call cotal_disconnect with your own connection_id and reply NATIVE_CLEANUP_COMPLETE.");
    await until(() => assistantSaid("NATIVE_CLEANUP_COMPLETE") && !input.peer.roster().some((row) => row.card.name === name && (row as any).status !== "offline"), "native disconnect");
    passed.push("native-exact-disconnect");
    console.log("  ✓ intended native disconnect retires its own conversation");
  } finally {
    input.sender.off("message", receiveReply);
    child.stdin.end();
    await Promise.race([exited, wait(10_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
    closeSync(out); closeSync(err);
    if (input.evidence) {
      mkdirSync(input.evidence, { recursive: true, mode: 0o700 });
      for (const file of ["native-stdout.jsonl", "native-stderr.log"]) copyFileSync(join(fixture, file), join(input.evidence, file), constants.COPYFILE_EXCL);
      const files = ["hooks/native-wake.js", "dist/mcp.cjs", "dist/hook.cjs", "dist/monitor.cjs"];
      writeFileSync(join(input.evidence, "receipt.json"), JSON.stringify({ model: "claude-sonnet-5-5", session, principal: nativePrincipal,
        passed, markers, hostedAcceptance: false, loginCacheCopied: false, childExited: child.exitCode !== null || child.signalCode !== null,
        fixtureInstrumentation: { delayedClaim: input.transitionRace === true, receiptAndBoundaryTrace: input.traceInline === true, deliveryLogicUnchanged: true },
        longBoundary: input.longBoundary === true, productBeforeInstrumentation: productHashes,
        receivedReplyContexts: receivedReplies.map(({ message }) => ({ id: message.id, replyTo: message.replyTo, contextId: message.contextId })),
        source: Object.fromEntries(files.map((file) => [file, createHash("sha256").update(readFileSync(join(plugin, file))).digest("hex")])) }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    }
  }
  assert(nativePrincipal, "native acceptance had no connected principal");
  return { principal: nativePrincipal, markers, stdout: readFileSync(join(fixture, "native-stdout.jsonl"), "utf8") };
}
