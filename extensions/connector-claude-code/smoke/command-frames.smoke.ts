/*
 * The command socket's one parser (`parseModFrame`) accepts every valid hello and answer and refuses
 * each malformed frame, one cell per rule. Every refused frame differs from an accepted one by the
 * one rule its cell names, so a refusal for some other reason cannot pass for it.
 *
 * Run: pnpm smoke:claude-command-frames
 * Graded: node scripts/mutation-proof.mjs --config extensions/connector-claude-code/smoke/mutations/command-frames.json
 */
import { isDeepStrictEqual } from "node:util";
import { createSuite } from "@cotal-ai/smoke-kit";
import { MAX_LINE_BYTES, parseModFrame } from "../src/command-frames.js";

const { check, finish } = createSuite();
const ID = "abcdefghijklmnopqrstuvwxyz";
const ID2 = "234567abcdefghijklmnopqrst";

let accepted = 0;
let refused = 0;
const line = (frame: unknown) => (typeof frame === "string" ? frame : JSON.stringify(frame));

/** The parser returns the frame it was given, unchanged. */
function accepts(name: string, frame: unknown): void {
  accepted++;
  try {
    const parsed = parseModFrame(line(frame));
    check(`accepts ${name}`, typeof frame === "string" || isDeepStrictEqual(parsed, frame), parsed);
  } catch (e) {
    check(`accepts ${name}`, false, (e as Error).message);
  }
}

/** The parser's own refusal, not an error some other code threw on the way. */
function refuses(name: string, frame: unknown): void {
  refused++;
  try {
    parseModFrame(line(frame));
    check(`refuses ${name}`, false, "it parsed");
  } catch (e) {
    check(`refuses ${name}`, (e as Error).message.startsWith("not a command mod frame: "), (e as Error).message);
  }
}

/** A list answer of exactly `bytes` UTF-8 bytes, every command in it valid. */
function listOfBytes(bytes: number): string {
  const full = { name: "c", description: "x".repeat(2048) };
  const per = Buffer.byteLength(JSON.stringify(full)) + 1;
  const overhead = Buffer.byteLength(JSON.stringify({ id: ID, op: "list", commands: [{ name: "c", description: "" }] }));
  const count = Math.floor((bytes - overhead) / per);
  const rest = bytes - overhead - count * per;
  const text = JSON.stringify({ id: ID, op: "list", commands: [...Array(count).fill(full), { name: "c", description: "x".repeat(rest) }] });
  if (Buffer.byteLength(text) !== bytes) throw new Error(`built ${Buffer.byteLength(text)} bytes, not ${bytes}`);
  return text;
}

const hello = { op: "hello", mod: "0.175.3", claude: "2.1.330" };
const started = { id: ID, op: "run", outcome: "started" };
const refusedRun = { id: ID, op: "run", outcome: "refused", reason: "opens a panel" };
const list = { id: ID, op: "list", commands: [{ name: "deploy", description: "Ship it", argumentHint: "<env>" }] };
const command = (fields: Record<string, unknown>) => ({ id: ID, op: "list", commands: [{ name: "deploy", ...fields }] });

console.log("accepted frames");
accepts("a hello", hello);
accepts("a hello from a prerelease Claude Code", { ...hello, claude: "2.1.331-rc.1+build.7" });
accepts("a hello whose versions are 64 characters", { op: "hello", mod: "1".repeat(64), claude: "2".repeat(64) });
accepts("a list answer with no commands", { id: ID2, op: "list", commands: [] });
accepts("a list answer with a description and an argument hint", list);
accepts("a list answer of 2048 commands", { id: ID, op: "list", commands: Array.from({ length: 2048 }, (_, i) => ({ name: `c${i}` })) });
accepts("a name of 128 characters", command({ name: "n".repeat(128) }));
accepts("a description and an argument hint of 4096 characters", command({ description: "d".repeat(4096), argumentHint: "a".repeat(4096) }));
accepts("a description of 4096 characters outside the BMP", command({ description: "😀".repeat(4096) }));
accepts("an empty description", command({ description: "" }));
accepts("a run started answer", started);
accepts("a run refused answer", refusedRun);
accepts("a run not-found answer", { id: ID, op: "run", outcome: "not-found", reason: "no command named nope" });
accepts("a reason of 2000 characters", { ...refusedRun, reason: "r".repeat(2000) });
accepts("an interrupt answer", { id: ID, op: "interrupt", outcome: "interrupted" });
accepts("an interrupt answer with a reason", { id: ID, op: "interrupt", outcome: "interrupted", reason: "a tool is still running" });
accepts("an idle interrupt answer", { id: ID, op: "interrupt", outcome: "idle" });
accepts("an error answer", { id: ID, op: "error", reason: "the mod could not list commands" });
accepts("a line of exactly 1 MiB", listOfBytes(MAX_LINE_BYTES));

console.log("refused frames");
refuses("a line that is not JSON", "{op:hello}");
refuses("a JSON array", "[]");
refuses("a JSON string", '"hello"');
refuses("JSON null", "null");
refuses("a frame with no op", { mod: hello.mod, claude: hello.claude });
refuses("an op the mod does not send", { op: "ready" });
refuses("an op that names an Object prototype member", { ...hello, op: "toString" });
refuses("a line one byte over 1 MiB", listOfBytes(MAX_LINE_BYTES + 1));
refuses("a hello with an unknown field", { ...hello, session: "s1" });
refuses("a hello with no mod", { op: "hello", claude: hello.claude });
refuses("a hello whose mod has a space", { ...hello, mod: "0.175 3" });
refuses("a hello whose claude version is 65 characters", { ...hello, claude: "2".repeat(65) });
refuses("a hello whose claude version is a number", { ...hello, claude: 2 });
refuses("an answer with no id", { op: "run", outcome: "started" });
refuses("an id of 25 characters", { ...started, id: ID.slice(1) });
refuses("an id with an uppercase letter", { ...started, id: `A${ID.slice(1)}` });
refuses("an id with a digit outside base32", { ...started, id: `1${ID.slice(1)}` });
refuses("an answer with an unknown field", { ...list, source: "user" });
refuses("a list whose commands is an object", { id: ID, op: "list", commands: { name: "deploy" } });
refuses("a list answer of 2049 commands", { id: ID, op: "list", commands: Array.from({ length: 2049 }, (_, i) => ({ name: `c${i}` })) });
refuses("a command that is a string", { id: ID, op: "list", commands: ["deploy"] });
refuses("a command that is null", { id: ID, op: "list", commands: [null] });
refuses("a command with an unknown field", command({ source: "user" }));
refuses("a command with no name", { id: ID, op: "list", commands: [{ description: "Ship it" }] });
refuses("an empty name", command({ name: "" }));
refuses("a name of 129 characters", command({ name: "n".repeat(129) }));
refuses("a name with whitespace", command({ name: "de ploy" }));
refuses("a description of 4097 characters", command({ description: "d".repeat(4097) }));
refuses("an argument hint of 4097 characters", command({ argumentHint: "a".repeat(4097) }));
refuses("a description that is not a string", command({ description: 7 }));
refuses("a run started answer with a reason", { ...started, reason: "extra" });
refuses("a run refused answer with no reason", { id: ID, op: "run", outcome: "refused" });
refuses("a run answer with an unknown outcome", { ...refusedRun, outcome: "unknown" });
refuses("an empty reason", { ...refusedRun, reason: "" });
refuses("a reason of 2001 characters", { ...refusedRun, reason: "r".repeat(2001) });
refuses("an interrupt answer with a run outcome", { id: ID, op: "interrupt", outcome: "started" });
refuses("an interrupt answer with an empty reason", { id: ID, op: "interrupt", outcome: "interrupted", reason: "" });
refuses("an error answer with no reason", { id: ID, op: "error" });

check("ran 19 accepted and 38 refused frames", accepted === 19 && refused === 38, { accepted, refused });
console.log(`command-frames.smoke: ${accepted} accepted, ${refused} refused`);
finish();
