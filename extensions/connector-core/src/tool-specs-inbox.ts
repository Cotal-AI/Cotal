/** The `cotal_inbox` tool and the inbox read it runs: what one response may carry and in what order,
 *  the notes on what it leaves buffered, the part reads of an oversized message, and the clearing of
 *  exactly what went out. `cotalToolSpecs` places it in the tool set. */
import { z } from "zod";
import { afterRecallMark, type MeshAgent, type InboxItem, type InboxScope } from "./agent.js";
import { attributionSafe, fmtDeliveryItem, fmtFrom } from "./framing.js";
import type { AgentConfig } from "./config.js";
import { ok, type CotalToolSpecDecl, type ToolCall, type ToolResult } from "./tool-specs-shared.js";

/** Why an empty local buffer says nothing about the mesh while the session cannot hear from it, or
 *  "" when it can. */
export function connectionNotReadyWarning(agent: MeshAgent): string {
  const state = agent.connectionState;
  if (state === "ready" || state === "stalled") return "";
  const issue = agent.connectionIssue;
  return `Mesh connection is not ready (${state})${issue ? `: ${issue.slice(0, 500)}` : "."}\nLocally buffered messages are still readable; an empty buffer does not mean no new mesh messages.`;
}

/** A local inbox read cannot establish that a session is receiving from the mesh. */
function inboxConnectionWarning(agent: MeshAgent): string {
  const channelIssue = agent.channelDeliveryIssue;
  // A role request whose take the delivery daemon could not decide is held, not shown (SPEC §8.1).
  const held = agent.heldTakes();
  const heldIssue = held.count && held.detail
    ? `${held.count} role request${held.count === 1 ? " is" : "s are"} held and not shown: ${held.detail}`
    : undefined;
  return [channelIssue, heldIssue, connectionNotReadyWarning(agent)].filter(Boolean).join("\n");
}

/**
 * HOW MUCH OF THE INBOX ONE RESPONSE MAY CARRY, in characters.
 *
 * A read is destructive, and the payload is largest exactly where recovery happens: reconnecting
 * brings a channel-history replay with it. Measured on a real reconnect: 200 messages, 3,490 lines,
 * 451 KB, an order of magnitude past what a host will hand to a model, so the call both CONSUMED
 * its contents and failed to deliver them. Whatever the host's own cap is, a response above this
 * bound is a response the caller may never see, so it is never a response we may clear.
 *
 * The budget is deliberately far below the smallest plausible host cap: overshooting costs a lost
 * message, undershooting costs one more call, and the response says so in its own text.
 */
export const INBOX_WINDOW_CHARS = 48_000;

/** What one response carries, what it leaves buffered, and the exact text that says so. */
export interface InboxResponse {
  /** The reply, already assembled and already inside the budget. Nothing may be appended to it. */
  text: string;
  /** What that text actually carries. Only these may be cleared. */
  shown: InboxItem[];
  /** Everything it does not carry. */
  held: InboxItem[];
  /** Receive keys no response could ever carry, whatever the window held at the time. Keyed like an
   *  ack, so two id-less items (#662) are never one entry. */
  stuck: ReadonlySet<string>;
}

/**
 * Build one inbox response, and make it impossible for the response to outgrow its own budget.
 *
 * THE HISTORY THIS SHAPE COMES FROM, because it explains why it assembles rather than estimates.
 * Three separate escapes were found here, each the same class one level further out: the items were
 * budgeted but an oversized one was shown alone anyway; the items were budgeted but the head line
 * and the held-note were not; the head and note were budgeted but the focus branch's recall warning
 * was appended afterwards. Every one of them was a writer to the response body that the arithmetic
 * did not know about. So the arithmetic is gone: this function ASSEMBLES the whole reply, measures
 * what it actually built, and drops trailing items until the real string fits. A future writer is
 * inside the bound by construction, because the bound is checked on the finished text.
 *
 * The order it drops in is the second rule: **mail before replay.** Direct messages and anycast
 * requests are first-party traffic with a sender waiting; replayed channel history is a backfill the
 * channel still holds. What gets dropped first is what someone else can still re-serve.
 *
 * And the third: **what does not fit is not cut off the end of the text.** It stays in the buffer,
 * unacked, named in {@link heldNote}. Only `shown` may be cleared, which is #603 itself.
 */
export function renderInbox(opts: {
  items: readonly InboxItem[];
  /** The line above the messages, given whatever ends up being shown. */
  head: (shown: readonly InboxItem[]) => string;
  peek?: boolean;
  /** A rider the response must carry, such as the focus branch's recall warning. */
  warning?: string;
  budget?: number;
  /**
   * Receive keys of a lane that must be delivered IN ORDER, with no gaps: focus recall, which a
   * caller walks with a single mark rather than an acknowledgement per item. Stepping over one of
   * these to fit a later one would either strand it, if the mark then passes it, or re-serve
   * everything after it, if the mark stops short. The buffered lane has no such constraint, because
   * each of its items is acked by receive key.
   */
  strictIds?: ReadonlySet<string>;
  /** Receive keys this reply may show, from an earlier render of the same items in the same order,
   *  so what it shows of the ordered lane is still an unbroken prefix. Anything else is only named
   *  as held. */
  only?: ReadonlySet<string>;
}): InboxResponse {
  const budget = opts.budget ?? INBOX_WINDOW_CHARS;
  const peek = opts.peek ?? false;
  const warning = opts.warning ?? "";
  const strictIds = opts.strictIds ?? new Set<string>();
  const rank = (i: InboxItem): number => {
    const current = i.mentionsMe && !i.historical;
    // A peek does not clear, so an old direct message that fills the window must not hide a current
    // mention. A clearing read keeps direct messages ahead of channel traffic, and a current mention
    // ahead of the rest of it, so older posts do not fill the read that follows the mention's wake.
    // The in-order recall lane keeps its order.
    if (peek && current) return -1;
    if (i.kind !== "channel") return 0;
    if (current && !strictIds.has(i.recvKey)) return 0.5;
    return i.historical ? 2 : 1;
  };
  // A peek does not clear, so an older message that fills the window must not hide a newer one of
  // the same kind. A reply that walks an ordered lane keeps receive order so its mark stays a prefix.
  const orderedLane = opts.strictIds !== undefined && opts.items.some((item) => opts.strictIds?.has(item.recvKey));
  const ordered = [...opts.items].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0 || !peek || orderedLane) return byRank;
    return b.ts - a.ts;
  });

  // WHY THIS AGREES WITH THE ASSEMBLED REPLY, and what would break the agreement. Deliverability is
  // decided here and delivery is decided by `assemble`, and the two can only agree because both
  // measure the item through the SAME `fmtDeliveryItem`. That is what makes the agreement invariant to how an
  // item renders: the continuation indent that keeps a peer from forging a line raised both sides by
  // the same characters, so nothing here had to change for it. Fork the rendering, and this
  // classification starts calling a message deliverable that the reply cannot carry.
  //
  // Stuck means "no response could carry this", so it is measured against the friendliest response
  // there is: this item alone, its head, and any rider, with no held-note at all.
  // Every set in this walk is keyed by receive key. An id-less item's wire id is the empty string,
  // so a set of wire ids makes every id-less item the same item: a held giant vanished from the
  // note when a small id-less item went out, and recall moved its mark past an unread one (#613).
  const stuck = new Set(
    ordered
      .filter((i) => opts.head([i]).length + 1 + itemCost(i) + (warning ? warning.length + 2 : 0) > budget)
      .map((i) => i.recvKey),
  );

  const assemble = (shown: InboxItem[], held: InboxItem[], tier: NoteTier): string => {
    const note = heldNote(held, peek, stuck, tier);
    const parts: string[] = [];
    if (shown.length) parts.push(`${opts.head(shown)}\n${shown.map(fmtDeliveryItem).join("\n")}${note}`);
    else if (held.length) parts.push(`Nothing could be delivered in this response.${note}`);
    if (warning) parts.push(warning);
    return parts.join("\n\n");
  };

  // THE NOTE YIELDS BEFORE THE LAST MESSAGE DOES, in this order: names, then counts, then nothing.
  // Measured before this rule: a 47,775-character direct message that renders alone at 47,823 was
  // never delivered at all while a 60,000-character message sat behind it, because the note NAMING
  // the undeliverable one pushed the pair over the window and the trim gave back the deliverable
  // message rather than the description of the other. Three calls, byte-identical at 396 characters,
  // nothing acked, every one of them saying to call again for the next batch.
  const fit = (shown: InboxItem[], held: InboxItem[]): string => {
    for (const tier of NOTE_TIERS) {
      const text = assemble(shown, held, tier);
      if (text.length <= budget) return text;
    }
    return assemble(shown, held, NOTE_TIERS[NOTE_TIERS.length - 1]);
  };

  // Fill from a cheap estimate first, SKIPPING what will not fit rather than stopping at it: one
  // message too large for any response must not block the mail behind it. Then assemble for real
  // and give back trailing items until the finished string fits, which is the part no future writer
  // to the response body can slip past.
  const shown: InboxItem[] = [];
  let used = 0;
  let strictGap = false; // the in-order lane stops at its first gap; the free lane steps over its own
  for (const i of ordered) {
    const strict = strictIds.has(i.recvKey);
    if (strict && strictGap) continue;
    if (opts.only && !opts.only.has(i.recvKey)) continue;
    const cost = itemCost(i);
    if (used + cost > budget) {
      // In the ordered lane even a message no response could carry whole is a gap: the mark would
      // pass it if the walk stepped over it, so the lane waits for it to go out in parts (#613).
      if (strict) strictGap = true;
      continue;
    }
    shown.push(i);
    used += cost;
  }
  const heldOf = (): InboxItem[] => {
    const keys = new Set(shown.map((i) => i.recvKey));
    return ordered.filter((i) => !keys.has(i.recvKey));
  };
  let held = heldOf();
  let text = assemble(shown, held, "full");
  while (text.length > budget && shown.length) {
    // While another message still rides in the response, the full note is worth an item: the caller
    // learns WHICH mail is undeliverable, and the item given back arrives on the next call. Down to
    // the last message that trade reverses, because giving THAT one back delivers nothing at all and
    // the next call rebuilds the same reply forever, so the note yields instead.
    if (shown.length === 1) {
      const yielded = fit(shown, held);
      if (yielded.length <= budget) {
        text = yielded;
        break;
      }
    }
    shown.pop();
    held = heldOf();
    text = assemble(shown, held, "full");
  }
  return { text, shown, held, stuck };
}

/** One inbox reply once the held role requests it carries are taken. `offered` is the buffer it was
 *  rendered over and `buffered` what of the buffer may be shown now. `part` is the message whose
 *  next part the reply carries when it carries no whole one, if the first pass took it. */
interface TakenReply {
  reply: InboxResponse;
  offered: InboxItem[];
  buffered: InboxItem[];
  part?: InboxItem;
}

/** How many times one read chooses its reply again after a take of a request it chose is refused. */
export const READ_TAKE_ROUNDS = 8;

/**
 * Render one reply over the inbox preview, take the held role requests it carries (or the one it
 * carries part of), then render it again over what may be shown now (SPEC §8.1). The second pass
 * shows only what the first chose, so a reply never takes a request it does not show. It renders a
 * subset of the first pass's items in the same order, so it fits wherever the first did. `extra`
 * rides after the buffer and needs no take, such as focus recall. `warning` is read at each render,
 * so the reply reports what the takes left held. A read whose caller is gone takes nothing.
 */
async function takeForReply(
  agent: MeshAgent,
  scope: InboxScope,
  opts: Omit<Parameters<typeof renderInbox>[0], "items" | "only" | "warning"> & { warning: () => string; signal?: AbortSignal },
  extra: readonly InboxItem[] = [],
): Promise<TakenReply> {
  const { warning, signal, ...render } = opts;
  let pending: Set<string> | undefined;
  let preview: InboxItem[] = [];
  let chosen = new Set<string>();
  let shown = new Set<string>();
  let part: InboxItem | undefined;
  let taken = new Set<string>();
  let showable: Set<string> | undefined;
  const undecided = new Set<string>();
  for (let round = 0; round < READ_TAKE_ROUNDS && !signal?.aborted; round++) {
    const got = await agent.takeChosen(scope, (p) => {
      // A read carries only what was pending when it began, so mail arriving meanwhile cannot push
      // out a request an earlier round took.
      pending ??= new Set(p.map((i) => i.recvKey));
      preview = p.filter((i) => pending!.has(i.recvKey));
      const candidates = showable ? preview.filter((i) => showable!.has(i.recvKey)) : preview;
      const first = renderInbox({ ...render, warning: warning(), items: [...candidates, ...extra] });
      shown = new Set(first.shown.map((i) => i.recvKey));
      part = first.shown.length ? undefined : candidates.find((i) => first.stuck.has(i.recvKey));
      const picked = [...candidates.filter((i) => shown.has(i.recvKey)), ...(part ? [part] : [])];
      chosen = new Set(picked.map((i) => i.recvKey));
      return picked;
    });
    taken = new Set(got.map((i) => i.recvKey));
    // A refused take leaves room another message can use, so the reply is chosen again without it. A
    // take still undecided would only repeat its wait if chosen again, so the reply is chosen once
    // more from what needs no take, and the undecided request waits for a later read.
    const missed = [...chosen].filter((k) => !taken.has(k));
    if (!missed.length || showable) break;
    const open = new Set(agent.inboxPreview(scope).map((i) => i.recvKey));
    for (const k of missed) if (open.has(k)) undecided.add(k);
    if (undecided.size) showable = new Set(agent.peekInbox(scope).map((i) => i.recvKey));
  }
  // A chosen request whose take was refused or is still undecided leaves this reply entirely. A reply
  // chosen again from what needs no take offers only that, so a request never asked is not named.
  const live = new Set(agent.inboxKeys(scope));
  const offered = preview.filter((i) => live.has(i.recvKey) && !undecided.has(i.recvKey) && (!chosen.has(i.recvKey) || taken.has(i.recvKey)) && (!showable || showable.has(i.recvKey)));
  return {
    reply: renderInbox({ ...render, warning: warning(), items: [...offered, ...extra], only: shown }),
    offered,
    buffered: agent.peekInbox(scope),
    part: part && taken.has(part.recvKey) ? part : undefined,
  };
}

/** How much the held-note is allowed to say, in the order it gives ground when the window is tight:
 *  who is held, then how many, then nothing. Delivery outranks describing what was not delivered. */
type NoteTier = "full" | "compact" | "none";

const NOTE_TIERS: readonly NoteTier[] = ["full", "compact", "none"];

/** What one rendered item costs a response: its own text plus the newline that joins it. */
function itemCost(i: InboxItem): number {
  return fmtDeliveryItem(i).length + 1;
}

/**
 * The tail that keeps a windowed response honest: what is still there, and that it was not lost.
 *
 * TWO KINDS OF HELD, because they are not the same promise. Most held mail is waiting its turn and
 * a later call delivers it whole. A message larger than one whole response never arrives whole: it
 * goes out in parts through {@link renderPart}, after the smaller mail, so the note says that rather
 * than promising it in the next batch.
 *
 * THE NOTE IS BOUNDED. It names at most {@link NAMED_STUCK} of the stuck messages and counts the
 * rest, and it truncates a sender's name, because a steady stream of oversized mail would otherwise
 * fill every reply with metadata about mail it cannot carry, which is the same overflow one layer up.
 */
function heldNote(
  held: readonly InboxItem[],
  peek = false,
  stuckIds: ReadonlySet<string> = new Set(),
  tier: NoteTier = "full",
): string {
  if (!held.length || tier === "none") return "";
  const stuck = held.filter((i) => stuckIds.has(i.recvKey));
  const waiting = held.length - stuck.length;
  if (tier === "compact") {
    const bits: string[] = [];
    if (waiting) bits.push(`${waiting} more message${waiting === 1 ? "" : "s"} held`);
    if (stuck.length) bits.push(`${stuck.length} too large for any response to carry`);
    const next = waiting
      ? peek
        ? " A peek clears nothing, so read without peek to take this window."
        : " Call cotal_inbox again for the next batch."
      : "";
    return `\n\n… ${bits.join(", ")}. Nothing held was cleared.${next}`;
  }
  const parts: string[] = [];
  if (waiting) {
    const dms = held.filter((i) => i.kind !== "channel" && !stuckIds.has(i.recvKey)).length;
    // Direct messages can hold back the mention that woke the reader, so the note says it waits.
    const mentions = held.filter((i) => i.mentionsMe && !i.historical && !stuckIds.has(i.recvKey)).length;
    // Under peek nothing is cleared, so the next call returns THIS window again. Telling a peeking
    // caller to call again for the next batch is a promise the read cannot keep, and an obedient
    // caller loops on it forever.
    const next = peek
      ? "A peek clears nothing, so calling again returns this same window; read without peek to take it and see the next."
      : "Call cotal_inbox again for the next batch.";
    parts.push(
      `${waiting} more message${waiting === 1 ? "" : "s"} held (${dms} direct${mentions ? `, ${mentions} mentioning you` : ""}). This response was capped at the receivable window, and nothing held was cleared. ${next}`,
    );
  }
  if (stuck.length) {
    const named = stuck
      .slice(0, NAMED_STUCK)
      .map((i) => `${fmtFrom(i, 40)} (${itemCost(i).toLocaleString("en-US")} chars)`)
      .join(", ");
    const rest = stuck.length - Math.min(NAMED_STUCK, stuck.length);
    parts.push(
      `${stuck.length} message${stuck.length === 1 ? " is" : "s are"} larger than one response can carry: ${named}${rest ? `, and ${rest} more` : ""}. ${stuck.length === 1 ? "It stays" : "They stay"} buffered and uncleared, and once no smaller mail is waiting, each call delivers the next part of one of them; a message is cleared only after its last part goes out.`,
    );
  }
  return `\n\n… ${parts.join(" ")}`;
}

/**
 * How far each oversized message has been read, by receive key, per agent (#613).
 *
 * It lives beside the agent rather than in the reply, so a reconnect, which keeps the agent and its
 * buffer, resumes where the last part ended. A process restart loses it, and the redelivered message
 * starts again from its first part: repeated, never skipped. An entry goes when its message is no
 * longer offered, whether by its last part or by anything else that consumed it.
 */
const partOffsets = new WeakMap<MeshAgent, Map<string, number>>();

/**
 * One `cotal_inbox` read at a time per agent (#613). A read decides what to hide, render and clear from
 * state it took before awaiting recall, so a second read that overlapped it decided from a snapshot the
 * first had already moved past: it hid a recalled message the first had just read in part, and moved
 * the recall mark past the rest of it. A read waits for the one before it to finish, failed or not.
 */
const inboxReads = new WeakMap<MeshAgent, Promise<unknown>>();

function oneReadAtATime<A>(
  read: (agent: MeshAgent, config: AgentConfig, args: A, call?: ToolCall) => Promise<ToolResult>,
): (agent: MeshAgent, config: AgentConfig, args: A, call?: ToolCall) => Promise<ToolResult> {
  return (agent, config, args, call) => {
    const turn = (inboxReads.get(agent) ?? Promise.resolve()).then(() => read(agent, config, args, call));
    inboxReads.set(agent, turn.catch(() => undefined));
    return turn;
  };
}

/** The read position for an oversized message, after dropping positions of messages no longer offered. */
function partCursor(agent: MeshAgent, offered: readonly InboxItem[]): Map<string, number> {
  let m = partOffsets.get(agent);
  if (!m) partOffsets.set(agent, (m = new Map()));
  const live = new Set(offered.map((i) => i.recvKey));
  for (const k of m.keys()) if (!live.has(k)) m.delete(k);
  return m;
}

/**
 * One part of a message no single response can carry: the next slice of its rendered form, with a
 * line saying which characters these are and whether more follow (#613).
 *
 * The slice is of the RENDERED item, so its indented continuations come with it, and it starts on
 * its own indented line, so a cut that lands mid-line cannot put peer text at column zero. Its size
 * is what the window has left once the line above it, the note and any rider are in, and the
 * finished text is measured like {@link renderInbox}'s. `end` is where the next part starts; the
 * caller clears the message only when `done`, and advances nothing on a peek.
 */
function renderPart(opts: {
  item: InboxItem;
  offset: number;
  peek: boolean;
  others: readonly InboxItem[];
  stuck: ReadonlySet<string>;
  warning?: string;
  budget?: number;
}): { text: string; end: number; done: boolean } {
  const budget = opts.budget ?? INBOX_WINDOW_CHARS;
  const full = fmtDeliveryItem(opts.item);
  const total = full.length;
  const fmt = (n: number): string => n.toLocaleString("en-US");
  const assemble = (end: number, tier: NoteTier): string => {
    const done = end >= total;
    const next = opts.peek
      ? "A peek advances nothing, so read without peek to take this part."
      : done
        ? "This was its last part, so it is now cleared."
        : "It stays buffered and uncleared until its last part goes out; call cotal_inbox again for the next part.";
    const head = `Part of a message larger than one response, from ${fmtFrom(opts.item, 40)}: characters ${fmt(opts.offset + 1)}-${fmt(end)} of ${fmt(total)}${opts.peek ? " (peek: nothing cleared)" : ""}. ${next}`;
    const body = `${head}\n  ${full.slice(opts.offset, end)}${heldNote(opts.others, opts.peek, opts.stuck, tier)}`;
    return opts.warning ? `${body}\n\n${opts.warning}` : body;
  };
  for (const tier of NOTE_TIERS) {
    // Measure everything but the slice with the widest numbers the header can carry, then fill.
    const room = budget - assemble(opts.offset, tier).length - 2 * fmt(total).length;
    if (room <= 0) continue;
    let end = Math.min(total, opts.offset + room);
    // Never split a surrogate pair across two parts.
    if (end < total && /[\uD800-\uDBFF]/.test(full[end - 1])) end--;
    const text = assemble(end, tier);
    if (text.length <= budget && end > opts.offset) return { text, end, done: end >= total };
  }
  throw new Error(`cotal_inbox: no room for a part of a ${fmt(total)}-character message in a ${fmt(budget)}-character window`);
}

/**
 * The reply for a call that could carry no whole message: the next part of `item`, a message too
 * large for any response, or `undefined` when there is none. The read position moves only when the
 * part went out, and `last` records the message as handed over only with its last part, so nothing
 * is cleared before it was handed over (#603). `last` is a buffered message's ack, or for focus
 * recall the mark or the ahead record that a whole recalled item would have moved.
 */
function partReply(opts: {
  agent: MeshAgent;
  item: InboxItem | undefined;
  /** Everything this call offered, so read positions of messages no longer offered are dropped. */
  offered: readonly InboxItem[];
  stuck: ReadonlySet<string>;
  peek: boolean;
  last: (item: InboxItem) => void;
  warning?: string;
}): string | undefined {
  const { agent, item, peek } = opts;
  if (!item) return undefined;
  const cursor = partCursor(agent, opts.offered);
  const part = renderPart({
    item,
    offset: cursor.get(item.recvKey) ?? 0,
    peek,
    others: opts.offered.filter((i) => i !== item),
    stuck: opts.stuck,
    warning: opts.warning,
  });
  if (!peek) {
    if (part.done) {
      opts.last(item);
      cursor.delete(item.recvKey);
    } else cursor.set(item.recvKey, part.end);
  }
  return part.text;
}

/**
 * The recall warning, bounded and budgeted like every other part of a response.
 *
 * It used to be appended AFTER the window had been filled, so its length rode outside the bound:
 * measured at a 49,598-character response, over the cap, with twenty already-acked messages inside
 * it. A caller with many silenced or expired channels is exactly the caller who gets a long list, so
 * the list itself is capped and counted rather than trusted to stay short.
 */
function droppedNote(channels: readonly string[]): string {
  if (!channels.length) return "";
  const named = channels.slice(0, NAMED_DROPPED).map((c) => `#${attributionSafe(c).slice(0, 40)}`).join(", ");
  const rest = channels.length - Math.min(NAMED_DROPPED, channels.length);
  return `⚠ Some earlier chatter could not be recalled completely on ${named}${rest ? `, and ${rest} more channel${rest === 1 ? "" : "s"}` : ""} (retention or local safety bounds were reached, or recall could not read the channel).`;
}

/** Said once after this session's stored copies reached their limit (#5404). NATS reports no discard,
 *  so it says "may". */
const storedCopiesNote = (limit: number): string => `⚠ Your stored copies reached their limit of ${limit}, so earlier channel posts may have been dropped before they reached you. Channel history may still hold them: \`cotal history <channel>\` reads it, within the space's history limit.`;

/** How many channels the recall warning names before it starts counting them instead. */
const NAMED_DROPPED = 5;

/** Every note in a reply starts at column zero, so any peer-controlled text it names goes through
 *  {@link attributionSafe} first. A warning is not a lesser surface than a message line: it is the
 *  part of the reply a caller is most likely to read as the tool speaking. */

/** How many senders the future-stamp note names before it starts counting them instead. */
const NAMED_AHEAD = 3;

/** Say that recall items were withheld because this session will not take responsibility for
 *  remembering them, and name who sent them, so a peer spending that bound is visible rather than
 *  silent. Not a drop: nothing was cleared and the stream still holds them. */
export function aheadNote(items: readonly InboxItem[]): string {
  if (!items.length) return "";
  const senders = [...new Set(items.map((i) => (i.fromName.trim() || i.fromId.trim() ? fmtFrom(i, 40) : "(unnamed)")))];
  const named = senders.slice(0, NAMED_AHEAD).join(", ");
  const rest = senders.length - Math.min(NAMED_AHEAD, senders.length);
  const one = items.length === 1;
  return `⚠ ${items.length} recalled message${one ? "" : "s"} from ${named}${rest ? `, and ${rest} more sender${rest === 1 ? "" : "s"}` : ""} ${one ? "is" : "are"} stamped ahead of this session's clock, more than it will hold a place for, so ${one ? "it is" : "they are"} not being handed over. Nothing was cleared.`;
}

/** How many oversized messages the note names before it starts counting them instead. */
const NAMED_STUCK = 3;

/** The `cotal_inbox` tool spec. `emptyInboxNote` is `cotalToolSpecs`'s parameter of that name. */
export function inboxToolSpecs(emptyInboxNote?: () => string | undefined): CotalToolSpecDecl[] {
  return [
    {
      name: "cotal_inbox",
      title: "Cotal: read incoming messages",
      description:
        "Read messages other agents have sent you since you last checked: channel broadcasts, direct messages, and role requests. It clears ONLY what it actually returns to you (nothing at all when peek is true), and one call carries at most a receivable window: direct messages and role requests first, then a current mention of you, then other channel traffic, with replayed history last. A peek shows a current mention of you before older direct messages too, and still clears nothing. A peek shows a newer direct message or role request before an older one that fills that window, and still clears nothing. When the window holds a mention back, the reply says so. Anything that does not fit stays buffered and is named in the reply, so call again for the next batch. A single message larger than one whole response is delivered in parts: once no smaller mail is waiting, each call carries the next part of it, a peek shows the current part without moving on, and the message is cleared only after its last part goes out. In focus mode it also pulls back the channel chatter held since you entered focus. If exclusion tracking makes a channel's focus recall unsafe, new non-historical mentions on that unmuted channel wake to pull their buffered bodies, never automatic injection, including on quiet channels. Ambient handling is unchanged, and the incomplete-recall warning still names unsafe channels. " +
        "When the connection is not ready, the reply says so and still returns locally buffered messages; an empty local buffer does not prove no new mesh messages exist. Exhausted channel drop tracking is reported even with an empty inbox; non-historical mentions on unmuted channels wake to pull their buffered bodies while ambient traffic stays suppressed. " +
        "If your stored copies reached their limit, 1000 unless an operator set another, the reply says earlier channel posts may have been dropped and that channel history may still hold them. A peek keeps that line for the next read.",
      schema: {
        peek: z.boolean().optional().describe("If true, show messages without clearing them."),
      },
      run: oneReadAtATime(async (agent, _config, { peek, scope }: { peek?: boolean; scope?: "pull-only" }, call) => {
        // A host that owns automatic delivery restricts clearing reads to pull-only. A peek clears
        // nothing, so it may show that queue too: the host still delivers and acks it at the boundary.
        const pulls = scope !== undefined && peek !== true;
        const inboxScope = pulls ? scope : "all";
        const stillDelivered = scope ? "; connector-managed messages still arrive at your turn's end" : "";
        // Asked at each clear, not once: the caller can go while this read waits for the one before
        // it or for focus recall, and what it never receives must stay for the next read.
        const keeps = () => peek === true || call?.signal?.aborted === true;
        // SELECT, RENDER, THEN CLEAR EXACTLY WHAT WENT OUT (#603). The old order drained the whole
        // scope up front, so a payload too large for the host to deliver had already been marked
        // read, and a reconnect replay is both the largest payload and the one most likely to have
        // a real DM inside it. This READ acks nothing outside the window it returned, on any path.
        // It is not the only acker: the inbox's own overflow valve acks the channel traffic it
        // evicts, so a channel item that arrives while this call is awaiting recall can still be
        // evicted and lost. That is the buffer's documented bounded local loss (see
        // MeshAgent.buffer), unchanged by this path; an evicted directed message is never acked.
        const automaticPending = scope ? agent.inboxCount("automatic") : 0;
        // Every reply below carries the stored-copy notice, and it clears as the messages do: once the
        // reply exists and its caller is still there. A recall that throws or a caller that goes keeps it.
        const storedSeen = agent.storedCopiesFull;
        const storedNote = storedSeen ? storedCopiesNote(agent.storedCopiesLimit) : "";
        const reply = (text: string): ToolResult => {
          if (storedSeen && !keeps()) agent.clearStoredCopiesFull(storedSeen);
          return ok(text);
        };
        if (agent.attention !== "focus") {
          // A peek shows bodies too, so a peek takes what it shows like any read.
          const { reply: rendered, offered, buffered, part: taken } = await takeForReply(agent, inboxScope, {
            peek,
            warning: () => [inboxConnectionWarning(agent), storedNote].filter(Boolean).join("\n"),
            signal: call?.signal,
            head: (s) =>
              pulls
                ? `${s.length} pull-only message${s.length === 1 ? "" : "s"} (cleared; automatic traffic remains connector-managed):`
                : `${s.length} message${s.length === 1 ? "" : "s"}${peek ? ` (peek: nothing cleared${stillDelivered})` : ""}:`,
          });
          const { text, shown, held, stuck } = rendered;
          // Asked after the takes: one this read asked for can have been held since.
          const connectionWarning = inboxConnectionWarning(agent);
          const warning = [connectionWarning, storedNote].filter(Boolean).join("\n");
          if (!offered.length) {
            return reply(
              [warning, pulls
                ? `No pull-only messages.${automaticPending ? ` ${automaticPending} connector-managed automatic message${automaticPending === 1 ? " is" : "s are"} still queued; peek to read ${automaticPending === 1 ? "it" : "them"} now.` : ""}`
                // A hook receipt never masks an unavailable connection, even with a live transport.
                : connectionWarning ? "Local inbox buffer is empty."
                  : (agent.connectionState === "ready" ? emptyInboxNote?.() : undefined) ?? "Inbox empty, no new messages."].filter(Boolean).join("\n\n"),
            );
          }
          if (!shown.length) {
            const part = partReply({
              agent,
              item: taken ?? buffered.find((i) => stuck.has(i.recvKey)),
              offered,
              stuck,
              peek: keeps(),
              warning,
              last: (i) => agent.drainInboxDeliveries([i.recvKey]),
            });
            if (part) return reply(part);
          }
          // The response exists before anything is acked: an ack is a claim that these messages were
          // handed over, so nothing may be cleared while the handing-over is still hypothetical. And
          // it is the ASSEMBLED response that decides, so what is acked is what a caller was handed.
          if (!keeps()) agent.drainInboxDeliveries(shown.map((i) => i.recvKey));
          void held;
          return reply(text);
        }
        // Focus: the live buffer holds only DMs/anycast; the channel ambient + @mentions were
        // acked-and-dropped at ingest, so pull them back from the channel stream here (replay-gated,
        // "since you entered focus"). Recall acks nothing, so peek only affects the live buffer.
        // A recalled message already part read stays offered until its last part goes out (#613).
        const before = new Set(agent.peekInbox("all").map((i) => i.recvKey));
        const underway = new Set([...(partOffsets.get(agent)?.keys() ?? [])].filter((k) => !before.has(k)));
        const recall = await agent.recallAmbient(underway);
        // RECALL HAS TO ADVANCE, or windowing it starves it. Recall is re-derived from an unchanged
        // frontier on every call, so showing its first window and stopping there returned the same
        // prefix forever while the reply promised a next batch: measured as three identical replies
        // where fifteen of thirty messages never appeared. The cursor is this session's own mark of
        // how far it has read, and it moves only when a call actually delivered them.
        // A SENDER'S CLOCK DOES NOT GET TO MOVE THIS SESSION'S MARK. `ts` is stamped by the sending
        // endpoint, so one peer running ahead, or one peer writing whatever it likes, otherwise parks
        // the mark in the future and every ordinary message after it is filtered out of recall for the
        // rest of the session, under a reply saying there is no chatter. So the walk splits: items at
        // or behind the clock are ordered by timestamp and move the mark, and items ahead of it are
        // handed over once, tracked by id, and never move it. The ahead lane needs no gap rule for the
        // same reason it needs no mark, since each of its items is accounted for on its own.
        // Ties break by receive key (#624): an empty wire id cannot order two distinct id-less
        // recall items, while a minted key can, and a minted key never equals a real wire id.
        const byTsThenId = (a: InboxItem, b: InboxItem): number =>
          a.ts !== b.ts ? a.ts - b.ts : a.recvKey < b.recvKey ? -1 : a.recvKey > b.recvKey ? 1 : 0;
        const clocked: InboxItem[] = [];
        const aheadFresh: InboxItem[] = [];
        const aheadWithheld: InboxItem[] = [];
        let aheadRoom = agent.recallAheadRoom();
        for (const i of recall.items) {
          if (!agent.recallAhead(i)) {
            // AN ITEM CAN CROSS BETWEEN THE LANES, because the local clock eventually passes a stamp
            // that was ahead of it. It was handed over by id while it was ahead, and the mark never
            // moved for it, so the mark alone would offer it a second time the moment it decays into
            // this lane. The record it was handed over under is what closes that.
            if (agent.recallAheadSeen(i.recvKey)) continue;
            if (afterRecallMark({ ts: i.ts, id: i.recvKey }, agent.recallCursor)) clocked.push(i);
            continue;
          }
          if (agent.recallAheadSeen(i.recvKey)) continue;
          // Never show what cannot be recorded: an unrecorded item comes back on every call forever.
          if (aheadRoom <= 0) aheadWithheld.push(i);
          else {
            aheadRoom--;
            aheadFresh.push(i);
          }
        }
        clocked.sort(byTsThenId);
        aheadFresh.sort(byTsThenId);
        const fresh = [...clocked, ...aheadFresh];
        const aheadIds = new Set(aheadFresh.map((i) => i.recvKey));
        const focusWarning = () => [inboxConnectionWarning(agent), storedNote, droppedNote(recall.droppedChannels), aheadNote(aheadWithheld)]
          .filter(Boolean)
          .join(" ");
        // Taken after recall, which can hand an id-less message back into the buffer (#662).
        const { reply: rendered, offered, buffered, part: taken } = await takeForReply(agent, inboxScope, {
          peek,
          warning: focusWarning,
          signal: call?.signal,
          strictIds: new Set(clocked.map((i) => i.recvKey)),
          head: (s) =>
            pulls
              ? `${s.length} message${s.length === 1 ? "" : "s"}. Buffered pull-only items were cleared; normal focus channel items are read-only recall:`
              : `${s.length} message${s.length === 1 ? "" : "s"}${peek ? ` (peek: live buffer not cleared${stillDelivered})` : ""} in focus mode; channel items are recall since you focused:`,
        }, fresh);
        const bufferedIds = new Set(buffered.map((i) => i.recvKey));
        const { text, shown: all, stuck } = rendered;
        // Asked after the takes: one this read asked for can have been held since.
        const connectionWarning = inboxConnectionWarning(agent);
        const warning = focusWarning();
        if (!offered.length && !fresh.length && !recall.droppedChannels.length && !aheadWithheld.length)
          return reply(
            [connectionWarning, storedNote, pulls
              ? `No pull-only messages and no normal focus recall.${automaticPending ? ` ${automaticPending} connector-managed automatic message${automaticPending === 1 ? " is" : "s are"} still queued; peek to read ${automaticPending === 1 ? "it" : "them"} now.` : ""}`
              : connectionWarning ? "Local inbox buffer and available focus recall are empty." : "Inbox empty, no new messages, and no channel chatter since you entered focus."].filter(Boolean).join("\n\n"),
          );
        if (!all.length) {
          // A recalled message goes out in parts too, and its last part moves what a whole one would
          // have: the mark for the ordered lane, whose first item is the only one it may take, or the
          // ahead record, so the mark never passes a message that has not been handed over.
          const first = clocked[0];
          const item =
            taken ??
            buffered.find((i) => stuck.has(i.recvKey)) ??
            (first && stuck.has(first.recvKey) ? first : aheadFresh.find((i) => stuck.has(i.recvKey)));
          const part = partReply({
            agent,
            item,
            offered: [...offered, ...fresh],
            stuck,
            peek: keeps(),
            warning,
            last: (i) => {
              if (bufferedIds.has(i.recvKey)) agent.drainInboxDeliveries([i.recvKey]);
              else if (aheadIds.has(i.recvKey)) agent.noteRecalledAhead(i.recvKey);
              else agent.noteRecalled({ ts: i.ts, id: i.recvKey });
            },
          });
          if (part) return reply(part);
        }
        // Render first, ack second, and only ever ids from the buffered lane: acking a recall id
        // would mark it handled, so a later live copy of that channel message would be dropped.
        if (!keeps()) {
          agent.drainInboxDeliveries(all.filter((i) => bufferedIds.has(i.recvKey)).map((i) => i.recvKey));
          // THE MARK MOVES OVER AN UNBROKEN PREFIX, and stops at the first thing this reply did not
          // carry. Two recall items can share a millisecond, so the mark is a (timestamp, id) pair:
          // a timestamp alone either strands the twin, if it moves past both, or re-serves the one
          // already delivered, if it stops below them. And it is the PREFIX that decides, not the
          // last item shown, because a pair too large to share one window leaves a hole: advancing
          // past a hole strands what is in it, which is total progress lost on an input that a
          // replay burst produces routinely.
          // The recall lane is filled in order and stops at its first gap, so what this reply carried
          // of it IS an unbroken prefix: the last recall item shown is the end of that prefix, and
          // the mark is exactly it. A walk over the prefix would compute the same value, which is why
          // the mutation for it survived and the code went rather than the test being weakened.
          const shownRecall = all.filter((i) => !bufferedIds.has(i.recvKey));
          for (const i of shownRecall) if (aheadIds.has(i.recvKey)) agent.noteRecalledAhead(i.recvKey);
          const shownClocked = shownRecall.filter((i) => !aheadIds.has(i.recvKey));
          const last = shownClocked[shownClocked.length - 1];
          if (last) agent.noteRecalled({ ts: last.ts, id: last.recvKey });
          void stuck;
        }
        return reply(text);
      }),
    },
  ];
}
