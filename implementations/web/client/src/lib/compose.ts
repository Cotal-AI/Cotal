// What the composer posts to, what it says under itself, what the sidebar footer says about the
// operator, and how a refused post reads. Plain functions over the route and the server's answers,
// so the suites call them in Node.
import type { PostCapability } from "../api/types.js";
import type { Route } from "./route.js";

/** Where a post goes: one channel, or one agent by id. The fields are `POST /api/send`'s body. */
export type ComposeTarget = { kind: "msg"; channel: string } | { kind: "dm"; to: string };

/** The key a target's draft is kept under. */
export const composeKey = (t: ComposeTarget): string => (t.kind === "msg" ? `msg\u0001${t.channel}` : `dm\u0001${t.to}`);

/** Where the composer on `route` posts. A channel route posts to its channel. A DM route posts to the
 *  agent it names, or, for a conversation that names the operator (`selfId`), to the other side. A
 *  conversation between two agents is not one the operator is in, so it has no composer, and nor
 *  has any other view. */
export function composeTarget(route: Route, selfId?: string | null): ComposeTarget | undefined {
  if (route.view === "channel") return { kind: "msg", channel: route.channel };
  if (route.view !== "dm") return undefined;
  const self = selfId ?? undefined;
  if (route.with === undefined) return route.peer === self ? undefined : { kind: "dm", to: route.peer };
  if (route.peer === self) return { kind: "dm", to: route.with };
  if (route.with === self) return { kind: "dm", to: route.peer };
  return undefined;
}

/** The server's reason for a dashboard started with `--creds`. Mirrors `POST_OFF_CREDS` in
 *  src/web.ts, which a suite compares it against. */
export const POST_OFF_CREDS = "This dashboard was started with --creds, which can only read.";

/** The note under a composer that posts. */
export const PARTICIPANT_NOTE = "You'll show on the roster as operator when you post. Replies come to your DMs.";

/** The line under the composer. Backticks mark inline code. Posting off with `--creds` says how to
 *  post; any other reason is said in the composer itself and the line stays empty. */
export function composerNote(post: PostCapability): string {
  if (post.mode === "participant") return PARTICIPANT_NOTE;
  return post.reason === POST_OFF_CREDS ? "Restart `cotal web` without `--creds` to post here." : "";
}

/** The command that posts the same thing from a terminal, for a composer that cannot. `name` is the
 *  agent's name, which `cotal send dm` takes. */
export function sendCommand(t: ComposeTarget, name: string): string {
  return t.kind === "msg" ? `cotal send msg ${t.channel} "<text>"` : `cotal send dm ${name} "<text>"`;
}

/** The second line of the sidebar footer, with its reason for the tooltip. Nothing until `/api/meta`
 *  has said what the dashboard can post as. `onRoster` is whether the operator's id is on the roster. */
export function footerLine(post: PostCapability | null, onRoster: boolean): { text: string; title: string } | undefined {
  if (post === null) return undefined;
  if (post.mode === "off") return { text: "Read only", title: post.reason };
  return onRoster
    ? { text: "On the roster", title: "You show on the roster as operator once you post, so agents can reply to you." }
    : { text: "Not on the roster", title: PARTICIPANT_NOTE };
}

/** A post the server refused: the HTTP status and the server's own `error` text. */
export class SendRefused extends Error {
  constructor(readonly status: number, readonly error: string) {
    super(error);
    this.name = "SendRefused";
  }
}

/** The refusal a non-200 answer to a post carries: its status and the server's `error` text, empty
 *  when the body is not `{"error": "..."}`. */
export async function sendRefusal(res: Response): Promise<SendRefused> {
  let error = "";
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    if (body && typeof body.error === "string") error = body.error;
  } catch {
    /* a refusal need not be JSON; the status still says what kind it was */
  }
  return new SendRefused(res.status, error);
}

/** What the composer says when a post to `where` (`#review`, or an agent's name) did not go out. Only
 *  a 502 is the broker's refusal; every other answer, and a request that never reached the server,
 *  is said as it came. The server's text ends the sentence with one period. */
export function refusalText(where: string, err: unknown): string {
  const status = err instanceof SendRefused ? err.status : undefined;
  const said = (err instanceof SendRefused ? err.error : err instanceof Error ? err.message : String(err)).trim();
  const why = said || (status === undefined ? "the request failed" : `HTTP ${status}`);
  const sentence = why.endsWith(".") ? why : `${why}.`;
  return `Couldn't post to ${where}. ${status === 502 ? `The broker refused it: ${sentence}` : sentence} Your message is still here.`;
}
