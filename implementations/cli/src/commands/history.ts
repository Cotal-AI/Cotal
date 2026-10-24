import { CotalEndpoint, isEventChannel, parseSubject, partsToText, spacePrefix, chatSubject, type CompletionResult, type CotalMessage, type FlagSpec, type FlagValues, type ParsedArgs, type Subcommand } from "@cotal-ai/core";
import {
  brokerAddressForDisplay,
  CommandFailure,
  connectOrThrow,
  endpointAuth,
  exitCode,
  jsonFlag,
  oneLine,
  plainFlag,
  presentationOf,
  renderReport,
  streamRecord,
  targetFlags,
  terminalWidth,
  writeResult,
  writeStreamRecord,
  type Cell,
  type Connection,
  type ConnectRefusal,
  type OutputWarning,
  type Report,
  recordOperationSpace,
} from "@cotal-ai/workspace";
import { credentialEnded } from "../lib/connect.js";
import { shownTime } from "../lib/shown-time.js";
import { c } from "../ui.js";
import { historyClear } from "./history-clear.js";
import { declaredFrom } from "./send.js";
import { completingFlagValue, positionalsForCompletion } from "../lib/completion.js";
import { listDeclaredChannels } from "../lib/personas.js";
import { concreteChannelProblem } from "../lib/concrete-channel.js";
import { streamsAbsent } from "../lib/space-streams.js";
import { scriptLine } from "../watch-data.js";

const dmsFlag = { name: "dms", type: "boolean", description: "also read DM history (needs a DM read grant); with clear, also clear DMs" } as const;
const forceFlag = { name: "force", type: "boolean", description: "removed spelling; use history clear --yes" } as const;
const yesFlag = { name: "yes", short: "y", type: "boolean", description: "clear: confirm the selected space-wide purge without prompting" } as const;
const dryRunFlag = { name: "dry-run", type: "boolean", description: "clear: show the selected target and streams without connecting; purge nothing. A space that is prepared but not started is refused" } as const;
const sinceFlag = { name: "since", type: "string", value: "<time|seq>", description: "only messages after a time (ISO 8601, or an age such as 30m, 2h, 1d) or a chat stream sequence" } as const;
const limitFlag = { name: "limit", type: "string", value: "<n>", description: "how many of the newest retained messages to read, 1 to 1000 (default 50)" } as const;
const fromFlag = { name: "from", type: "string", value: "<name>", description: "keep messages from this sender name or id (filters the window)" } as const;
const grepFlag = { name: "grep", type: "string", value: "<text>", description: "keep messages whose text contains this, case-insensitive (filters the window)" } as const;
const followFlag = { name: "follow", type: "boolean", description: "keep listening and print each new message (NDJSON with --json)" } as const;
export const historyFlags = [...targetFlags, dmsFlag, forceFlag, yesFlag, dryRunFlag, sinceFlag, limitFlag, fromFlag, grepFlag, followFlag, jsonFlag, plainFlag] as const satisfies readonly FlagSpec[];

export const historySubcommands = [
  { name: "clear", summary: "confirm and purge all retained channel history in the selected space", usage: "clear [--dms] [--yes|--dry-run] [--json|--plain]", outputs: ["json", "plain"], prepareMeshTarget: false },
] as const satisfies readonly Subcommand[];

/** Complete `clear` and the channels the target space's personas declare, as `send -c` offers, then
 *  the flags. */
export function historyComplete(argv: string[]): CompletionResult {
  if (completingFlagValue(argv, historyFlags)) return { items: [], directive: "nofiles" };
  if (positionalsForCompletion(argv, historyFlags).length === 1)
    return { items: [...historySubcommands.map((sub) => ({ value: sub.name, description: sub.summary })), ...declaredFrom(argv, listDeclaredChannels).map((value) => ({ value }))], directive: "nofiles" };
  return { items: historyFlags.map((flag) => ({ value: `--${flag.name}`, description: flag.description })), directive: "nofiles" };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
/** How many message ids a follow remembers to drop duplicates: a re-tap after a reconnect and the
 *  snapshot both overlap the live feed. */
const SEEN_IDS = 10_000;
/** How many characters of a message a text or plain row shows. */
const ROW_TEXT = 500;

/** A message's text as a row shows it: whole up to `ROW_TEXT` characters, else cut there and marked
 *  with its size, since `--limit` bounds messages and one message can be close to a megabyte. */
function rowText(text: string): string {
  let head = "", count = 0;
  for (const char of text) {
    if (count++ === ROW_TEXT) return `${head}… (cut from ${Buffer.byteLength(text)} bytes; --json carries the whole text)`;
    head += char;
  }
  return text;
}
/** How long a `--dms` read waits for the roster that names DM recipients before it shows principals. */
const ROSTER_MS = 2_000;

/** One retained message as `history` reports it. `seq` is the chat stream sequence; DMs and reads
 *  mediated by the delivery daemon carry none. */
export interface HistoryItem {
  readonly seq: number | null;
  readonly id: string;
  readonly ts: string;
  readonly channel: string | null;
  readonly to: string | null;
  readonly from: { readonly id: string; readonly name: string };
  readonly text: string;
}

/** What `cotal history` read: the newest `limit` retained messages of its selection, oldest first,
 *  then filtered by `--since`, `--from` and `--grep`. It never claims complete history: `olderRetained`
 *  says whether retained messages older than the window exist, `reachesSince` whether the window goes
 *  back to `--since`, and `retention` names the limits that remove messages and each sender whose
 *  older messages a channel has lost to them. */
export interface HistoryResult {
  readonly kind: "history";
  readonly channels: string[];
  readonly dms: boolean;
  readonly window: {
    readonly limit: number;
    readonly read: number;
    readonly olderRetained: boolean | null;
    readonly since: string | null;
    readonly reachesSince: boolean | null;
    readonly from: string | null;
    readonly grep: string | null;
  };
  readonly retention: {
    readonly perSender: number | null;
    readonly maxAgeMs: number | null;
    readonly gaps: { readonly channel: string; readonly sender: string; readonly name: string | null; readonly retained: number }[];
  } | null;
  readonly replay: { readonly channel: string; readonly replay: boolean | null; readonly window: string | null }[];
  readonly denied: string[];
  readonly items: HistoryItem[];
}

/** `input` is the value as given; `text` is the sequence, or the time it resolved to as ISO. */
type Since = { kind: "seq"; seq: number; text: string; input: string } | { kind: "time"; ms: number; text: string; input: string };

const usage = (message: string): CommandFailure => new CommandFailure("refused", "USAGE_INVALID", message);

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw usage(`--limit takes a whole number from 1 to ${MAX_LIMIT}, not "${raw}"`);
  return n;
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

