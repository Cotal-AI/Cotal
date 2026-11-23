/**
 * The frames a seat's MCP server and its Claude Code command mod exchange on the command socket
 * (`command-feed.ts`): one JSON object per line. Requests go from the server to the mod. The reader's
 * hello and the mod's answers come back, and {@link parseModFrame} is the only code that reads them.
 */

/** 26 random lowercase base32 characters, never reused. */
export type RequestId = string;

/** What the server asks the mod, before the feed gives it an id. */
export type CommandAsk =
  | { op: "list" }
  | { op: "run"; command: string; args: string }
  | { op: "interrupt" }
  | { op: "prompt"; text: string }
  | { op: "usage" };

export type CommandRequest = CommandAsk & { id: RequestId };

/** The first line of a reader connection. `mod` is the connector version the reader was built
 *  from; `claude` is the version of the Claude Code session it runs in. */
export interface ModHello { op: "hello"; mod: string; claude: string }

export interface ModCommand { name: string; description?: string; argumentHint?: string }

export type ModAnswer =
  | { id: RequestId; op: "list"; commands: ModCommand[] }
  | { id: RequestId; op: "run"; outcome: "started" }
  | { id: RequestId; op: "run"; outcome: "refused" | "not-found"; reason: string }
  | { id: RequestId; op: "interrupt"; outcome: "interrupted" | "idle"; reason?: string }
  | { id: RequestId; op: "prompt"; outcome: "submitted" }
  | { id: RequestId; op: "prompt"; outcome: "refused"; reason: string }
  /** Claude Code's own figures: the context window, the input tokens of the last response over it,
   *  and the session's cost in US dollars. */
  | { id: RequestId; op: "usage"; window: number; tokens?: number; usd?: number }
  | { id: RequestId; op: "error"; reason: string };

export type ModFrame = ModHello | ModAnswer;

/** The longest line the mod side sends, in UTF-8 bytes. A list answer is the largest frame. */
export const MAX_LINE_BYTES = 1024 * 1024;
/** The longest request line, in UTF-8 bytes. A prompt is the largest: up to 262144 characters of
 *  turn text, each at most 6 bytes once JSON-escaped, and its image paths. */
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

const ID = /^[a-z2-7]{26}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const NAME = /^\S{1,128}$/u;
const MAX_COMMANDS = 2048;
const MAX_TEXT = 4096;
const MAX_REASON = 2000;

type Fields = Record<string, unknown>;

function refuse(why: string): never {
  throw new Error(`not a command mod frame: ${why}`);
}

const isFields = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);

/** `f` has no key outside `allowed`. Each field's own check refuses it when it is missing. */
function only(f: Fields, allowed: readonly string[]): void {
  for (const k of Object.keys(f)) if (!allowed.includes(k)) refuse(`unknown field ${k}`);
}

function matches(v: unknown, pattern: RegExp, field: string): void {
  if (typeof v !== "string" || !pattern.test(v)) refuse(`${field} does not match ${pattern.source}`);
}

/** A string of `min` to `max` characters, counted in code points. */
function text(v: unknown, field: string, min: number, max: number): void {
  if (typeof v !== "string") refuse(`${field} is not a string`);
  const length = [...v].length;
  if (length < min || length > max) refuse(`${field} is not ${min} to ${max} characters`);
}

function count(v: unknown, field: string): void {
  if (!Number.isSafeInteger(v) || (v as number) < 0) refuse(`${field} is not a whole number of tokens`);
}

function oneOf(v: unknown, allowed: readonly string[], field: string): void {
  if (typeof v !== "string" || !allowed.includes(v)) refuse(`${field} is not one of ${allowed.join(", ")}`);
}

function commands(v: unknown): void {
  if (!Array.isArray(v)) refuse("commands is not an array");
  if (v.length > MAX_COMMANDS) refuse(`commands has more than ${MAX_COMMANDS} entries`);
  for (const c of v) {
    if (!isFields(c)) refuse("a command is not an object");
    only(c, ["name", "description", "argumentHint"]);
    matches(c.name, NAME, "name");
    if (Object.hasOwn(c, "description")) text(c.description, "description", 0, MAX_TEXT);
    if (Object.hasOwn(c, "argumentHint")) text(c.argumentHint, "argumentHint", 0, MAX_TEXT);
  }
}

/** One check per `op`; each refuses a frame of that op that breaks a rule. */
const FRAMES: Record<ModFrame["op"], (f: Fields) => void> = {
  hello(f) {
    only(f, ["op", "mod", "claude"]);
    matches(f.mod, VERSION, "mod");
    matches(f.claude, VERSION, "claude");
  },
  list(f) {
    only(f, ["id", "op", "commands"]);
    matches(f.id, ID, "id");
    commands(f.commands);
  },
  run(f) {
    if (f.outcome === "started") only(f, ["id", "op", "outcome"]);
    else {
      only(f, ["id", "op", "outcome", "reason"]);
      oneOf(f.outcome, ["refused", "not-found"], "outcome");
      text(f.reason, "reason", 1, MAX_REASON);
    }
    matches(f.id, ID, "id");
  },
  interrupt(f) {
    only(f, ["id", "op", "outcome", "reason"]);
    matches(f.id, ID, "id");
    oneOf(f.outcome, ["interrupted", "idle"], "outcome");
    if (Object.hasOwn(f, "reason")) text(f.reason, "reason", 1, MAX_REASON);
  },
  prompt(f) {
    if (f.outcome === "submitted") only(f, ["id", "op", "outcome"]);
    else {
      only(f, ["id", "op", "outcome", "reason"]);
      oneOf(f.outcome, ["refused"], "outcome");
      text(f.reason, "reason", 1, MAX_REASON);
    }
    matches(f.id, ID, "id");
  },
  usage(f) {
    only(f, ["id", "op", "window", "tokens", "usd"]);
    matches(f.id, ID, "id");
    count(f.window, "window");
    if (Object.hasOwn(f, "tokens")) count(f.tokens, "tokens");
    if (Object.hasOwn(f, "usd") && !(typeof f.usd === "number" && Number.isFinite(f.usd) && f.usd >= 0)) refuse("usd is not a number of dollars");
  },
  error(f) {
    only(f, ["id", "op", "reason"]);
    matches(f.id, ID, "id");
    text(f.reason, "reason", 1, MAX_REASON);
  },
};

/** Read one line the mod side sent. Throws on anything that is not a valid hello or answer. */
export function parseModFrame(line: string): ModFrame {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) refuse(`the line is over ${MAX_LINE_BYTES} bytes`);
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    refuse("the line is not JSON");
  }
  if (!isFields(frame)) refuse("the line is not a JSON object");
  const op = frame.op;
  if (typeof op !== "string" || !Object.hasOwn(FRAMES, op)) refuse(`unknown op ${JSON.stringify(op)}`);
  FRAMES[op as ModFrame["op"]](frame);
  return frame as unknown as ModFrame;
}
