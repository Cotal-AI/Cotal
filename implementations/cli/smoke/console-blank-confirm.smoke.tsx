import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import React from "react";
import { render } from "ink";
import { Confirm, shownKillName } from "../src/console/ui/Confirm.js";
import { NewAgent } from "../src/console/ui/NewAgent.js";
import { replyFromSpawnOutput, type AgentLaunchReply } from "../src/console/launch.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
let checks = 0;
const ok = (cond: boolean, message: string, extra?: string): void => {
  assert.ok(cond, extra === undefined ? message : `${message}\n${extra}`);
  checks++;
  console.log(`  ✓ ${message}`);
};

function ttyIn(): NodeJS.ReadStream {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

async function paint(el: React.ReactElement, rows = 24): Promise<string> {
  let buf = "";
  const sink = new Writable({ write(c, _e, cb) { buf += String(c); cb(); } }) as unknown as NodeJS.WriteStream;
  sink.columns = 100;
  sink.rows = rows;
  const app = render(el, { stdin: ttyIn(), stdout: sink, patchConsole: false, exitOnCtrlC: false });
  await new Promise((r) => setTimeout(r, 150));
  app.unmount();
  return strip(buf);
}

function stopLine(frame: string): string {
  return frame.split("\n").find((row) => row.includes("Stop agent")) ?? frame;
}

const kill = async (name: string, id: string): Promise<string> =>
  stopLine(await paint(<Confirm target={{ kind: "kill", name, id }} width={90} height={16} onConfirm={() => {}} onCancel={() => {}} />));

const space = await kill(" ", "local.blank");
ok(space.includes("local.blank") && space.includes("via the manager"), "a whitespace stop name is the id", space);
const empty = await kill("", "local.blank");
ok(empty.includes("local.blank") && empty.includes("via the manager"), "an empty stop name is the id", empty);
const newline = await kill("\n", "local.blank");
ok(newline.includes("local.blank") && newline.includes("via the manager"), "a newline stop name stays on one line as the id", newline);
const kept = await kill(" ada", "local.blank");
ok(kept.includes(" ada") && !kept.includes("local.blank"), "a stop name with a leading space stays", kept);
const named = await kill("ada", "local.blank");
ok(named.includes("ada") && !named.includes("local.blank"), "a stop name stays", named);
const unnamed = await kill(" ", " ");
ok(unnamed.includes("(unnamed)") && unnamed.includes("via the manager"), "a blank stop name and id is unnamed", unnamed);
ok(shownKillName(" ", "local.blank") === "local.blank", "the stop status line uses the id for a blank name");
ok(`stopping ${shownKillName("\n", "local.blank")}…` === "stopping local.blank…", "a newline stop status stays on one line");
ok(`stopped ${shownKillName(" ada", "local.blank")}` === "stopped  ada", "a stop status keeps a leading space");

function receipt(name: string, id?: string): string {
  return JSON.stringify({
    schemaVersion: 1, command: "spawn", outcome: "ok", warnings: [],
    result: {
      kind: "managed-launch", readiness: "joined", name, ...(id === undefined ? {} : { id }),
      managerInstanceId: "mgr-1", requestedModel: null,
    },
  });
}

const tick = () => new Promise((r) => setTimeout(r, 40));
async function joinedLine(reply: AgentLaunchReply): Promise<string> {
  let buf = "";
  const stdin = ttyIn();
  const stdout = new Writable({ write(c, _e, cb) { buf += String(c); cb(); } }) as unknown as NodeJS.WriteStream;
  stdout.columns = 100;
  stdout.rows = 30;
  const app = render(<NewAgent space="s" width={100} height={30} applications={[]} defaultPersona="default"
    onBack={() => {}} onClose={() => {}} onLaunch={async () => reply} />,
    { stdin, stdout, patchConsole: false, exitOnCtrlC: false, debug: true });
  const deadline = Date.now() + 1500;
  while (!strip(buf).includes("Application") && Date.now() < deadline) await tick();
  for (let i = 0; i < 6; i++) { stdin.write("\t"); await tick(); }
  stdin.write("\r");
  const done = Date.now() + 1500;
  while (!strip(buf).includes("running in the background") && Date.now() < done) await tick();
  app.unmount();
  return strip(buf).split("\n").find((row) => row.includes("running in the background")) ?? strip(buf);
}

const blankReply = replyFromSpawnOutput(0, receipt(" ", "local.blank"), 200);
ok(blankReply.ok && blankReply.id === "local.blank" && blankReply.name === " ", "a blank receipt name keeps the id", JSON.stringify(blankReply));
const blankLine = await joinedLine(blankReply);
ok(blankLine.includes("local.blank is running in the background."), "a whitespace joined name is the id", blankLine);
const emptyLine = await joinedLine(replyFromSpawnOutput(0, receipt("", "local.blank"), 200));
ok(emptyLine.includes("local.blank is running in the background."), "an empty joined name is the id", emptyLine);
const newlineLine = await joinedLine(replyFromSpawnOutput(0, receipt("\n", "local.blank"), 200));
ok(newlineLine.includes("local.blank is running in the background."), "a newline joined name stays on one line as the id", newlineLine);
const keptReply = replyFromSpawnOutput(0, receipt(" ada", "local.blank"), 200);
const keptLine = await joinedLine(keptReply);
ok(keptLine.includes(" ada is running in the background.") && !keptLine.includes("local.blank"), "a joined name with a leading space stays", keptLine);
const namedLine = await joinedLine(replyFromSpawnOutput(0, receipt("ada", "local.blank"), 200));
ok(namedLine.includes("ada is running in the background.") && !namedLine.includes("local.blank"), "a joined name stays", namedLine);
const noId = replyFromSpawnOutput(0, receipt(" "), 200);
ok(noId.ok && noId.id === undefined, "a joined receipt without an id still succeeds");
const noIdLine = await joinedLine(noId);
ok(noIdLine.includes("(unnamed) is running in the background."), "a blank joined name with no id is unnamed", noIdLine);

console.log(`console blank confirm: ${checks} checks passed`);
