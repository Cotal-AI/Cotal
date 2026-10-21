/**
 * The live terminal view of one admitted chat opening (Ink). It renders the pure model in `view.ts`
 * and runs its intents through `controller.ts`; it owns no authority, opens nothing, and never
 * constructs a session. Lazy-loaded by the command, like `watch-view.tsx`.
 *
 * Input mapping: Ink hands a pasted run of characters to `useInput` as ONE `input` string, and a
 * lone `\r` / `\n` as a return key. Any multi-character input is therefore treated as a paste and
 * goes into the draft as data, never as a send, even when it contains newlines. Shift+Enter is only
 * distinguished when the terminal reports it (kitty keyboard protocol); otherwise Enter always sends.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { Key as InkKey } from "ink";
import type { AdmittedChatSession, SessionEvent } from "./session.js";
import {
  addNotice,
  applyEvent,
  applyKey,
  composerRows,
  headerRows,
  initialState,
  setRecipient,
  transcriptRows,
  type ChatState,
  type Key,
  type Recipient,
  type Row,
  type Tone,
} from "./view.js";
import { closeSession, runPublish, runSlash } from "./controller.js";
import { discloseChoice, listChoices, parseRecipient, type Choice } from "./picker.js";

const TONE_COLOR: Record<Tone, string | undefined> = {
  ok: "green",
  waiting: "yellow",
  failed: "red",
  hint: undefined,
  label: undefined,
  selected: "blue",
  body: undefined,
};

/** Map one Ink input event to the model's `Key`, or undefined for keys the chat does not use. */
export function toKey(input: string, key: InkKey): Key | undefined {
  if (key.ctrl && input === "c") return { kind: "ctrl-c" };
  if (key.ctrl && input === "d") return { kind: "ctrl-d" };
  if (key.return) return { kind: "enter", shift: key.shift === true };
  if (key.escape) return { kind: "escape" };
  if (key.tab) return { kind: "tab" };
  if (key.backspace || key.delete) return { kind: "backspace" };
  if (key.ctrl || key.meta || key.super || key.hyper) return undefined;
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.pageUp || key.pageDown || key.home || key.end) return undefined;
  if (!input) return undefined;
  // A multi-character chunk is a paste (or a fast burst); either way it is data.
  return [...input].length > 1 ? { kind: "paste", text: input.replace(/\r\n?/g, "\n") } : { kind: "char", text: input };
}

function RowsView({ rows, keyPrefix }: { rows: readonly Row[]; keyPrefix: string }) {
  return <>{rows.map((r, i) => <Text key={`${keyPrefix}-${i}`} color={TONE_COLOR[r.tone]} dimColor={r.tone === "hint" || r.tone === "label"} wrap="truncate-end">{r.text}</Text>)}</>;
}

export interface ChatViewProps {
  session: AdmittedChatSession;
  initialRecipient?: Recipient;
  /** A disclosure about the initial recipient, shown before anything else. */
  notice?: string;
  /** Whether the terminal reports Shift+Enter distinctly. Measured by the caller, never assumed. */
  shiftEnterDistinct: boolean;
  /** Called once with the final state after the session has been closed. */
  onDone: (state: ChatState) => void;
}

type Picker = { readonly choices: readonly Choice[]; readonly typed: string };

export function ChatView({ session, initialRecipient, notice, shiftEnterDistinct, onDone }: ChatViewProps) {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({ width: Math.max(20, stdout.columns ?? 80), height: Math.max(8, stdout.rows ?? 24) }));
  const [state, setState] = useState<ChatState>(() => {
    const first = initialState(session.identity(), initialRecipient);
    return notice ? addNotice(first, "waiting", notice) : first;
  });
  const [picker, setPicker] = useState<Picker | undefined>(undefined);
  // The latest state for async continuations; React state is the render copy.
  const latest = useRef(state);
  latest.current = state;
  // Deliveries shown in the last paint, acknowledged after it commits.
  const unacked = useRef<string[]>([]);
  const closing = useRef(false);
  // Intents run strictly one after another, in key order. Nothing is dropped: the model already
  // refuses a second publish while one is pending, so the queue never grows by sends.
  const queue = useRef<Promise<void>>(Promise.resolve());

  const update = useCallback((next: ChatState) => {
    latest.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    const resize = () => setSize({ width: Math.max(20, stdout.columns ?? 80), height: Math.max(8, stdout.rows ?? 24) });
    stdout.on("resize", resize);
    const unsubscribe = session.subscribe((event: SessionEvent) => {
      if (event.type === "message") unacked.current.push(event.message.deliveryKey);
      update(applyEvent(latest.current, event));
    });
    return () => {
      stdout.off("resize", resize);
      unsubscribe();
    };
  }, [stdout, session, update]);

  // Acknowledge only after the frame that shows the messages has been committed.
  useEffect(() => {
    if (!unacked.current.length) return;
    const keys = unacked.current;
    unacked.current = [];
    session.surfaced(keys);
  }, [state, session]);

  const leave = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    // Let an in-flight send finish and record its outcome first; queued work after it is skipped.
    await queue.current.catch(() => {});
    const ended = await closeSession(session, latest.current);
    update(ended);
    onDone(ended);
  }, [session, update, onDone]);

  const openPicker = useCallback(async () => {
    const [conn, roster] = await Promise.all([session.connection(), session.roster()]).catch(() => [undefined, undefined] as const);
    const choices = listChoices(conn?.outcome === "ok" ? conn.value : undefined, roster?.outcome === "ok" ? roster.value : undefined, latest.current.identity.principal);
    let s = latest.current;
    if (roster && roster.outcome !== "ok") s = addNotice(s, roster.outcome === "refused" ? "failed" : "waiting", `roster ${roster.outcome}: ${roster.message}`);
    update(s);
    setPicker({ choices, typed: "" });
  }, [session, update]);

  const choose = useCallback(async (recipient: Recipient) => {
    setPicker(undefined);
    const warning = await discloseChoice(session, recipient);
    let s = setRecipient(latest.current, recipient);
    if (warning) s = addNotice(s, "waiting", warning);
    update(s);
  }, [session, update]);

  useInput((input, inkKey) => {
    const key = toKey(input, inkKey);
    // Ctrl-C and Ctrl-D close the picker, then act as they do in the composer: leave, or ask first
    // when there is a draft.
    if (picker && (key?.kind === "ctrl-c" || key?.kind === "ctrl-d")) setPicker(undefined);
    else if (picker) {
      // Picker input: a number picks a listed choice, Enter takes typed text, Esc backs out.
      if (inkKey.escape) return setPicker(undefined);
      if (inkKey.backspace || inkKey.delete) return setPicker({ ...picker, typed: [...picker.typed].slice(0, -1).join("") });
      if (inkKey.return) {
        const n = Number(picker.typed);
        if (Number.isInteger(n) && n >= 1 && n <= picker.choices.length) return void choose(picker.choices[n - 1]!.recipient);
        const parsed = parseRecipient(picker.typed);
        if (!parsed.ok) return update(addNotice(latest.current, "failed", parsed.error));
        return void choose(parsed.recipient);
      }
      if (inkKey.ctrl || inkKey.meta || !input) return;
      return setPicker({ ...picker, typed: (picker.typed + input).slice(0, 600) });
    }
    if (!key) return;
    const { state: next, intent } = applyKey(latest.current, key, shiftEnterDistinct);
    update(next);
    if (!intent) return;
    if (intent.kind === "leave") return void leave();
    if (intent.kind === "pick-recipient") return void openPicker();
    queue.current = queue.current.then(async () => {
      if (closing.current) return;
      const { state: s, ack } = intent.kind === "publish"
        ? { state: await runPublish(session, latest.current, intent.to, intent.text), ack: [] as readonly string[] }
        : await runSlash(session, latest.current, intent.command);
      if (ack.length) unacked.current.push(...ack);
      update(s);
    });
  });

  const header = headerRows(state);
  const composer = picker
    ? [
        ...picker.choices.map((c, i): Row => ({ text: `${i + 1}. ${c.label}${c.detail ? ` · ${c.detail}` : ""}`, tone: "body" })),
        { text: `to: ${picker.typed}`, tone: "selected" } as Row,
        { text: "number or #channel / @name / role:<role> · Enter choose · Esc back", tone: "hint" } as Row,
      ]
    : composerRows(state, size.width, shiftEnterDistinct);
  const bodyHeight = Math.max(1, size.height - header.length - composer.length - 2);
  const body = transcriptRows(state, size.width).slice(-bodyHeight);

  return <Box flexDirection="column" width={size.width} height={size.height}>
    <RowsView rows={header} keyPrefix="h" />
    <Text dimColor>{"─".repeat(size.width)}</Text>
    <Box flexDirection="column" height={bodyHeight}>
      {body.length ? <RowsView rows={body} keyPrefix="t" /> : <Text dimColor>No messages yet in this session.</Text>}
    </Box>
    <Text dimColor>{"─".repeat(size.width)}</Text>
    <RowsView rows={composer} keyPrefix="c" />
  </Box>;
}
