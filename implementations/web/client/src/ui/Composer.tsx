import { ArrowUp02Icon, AtIcon, SquareLock02Icon } from "@hugeicons/core-free-icons";
import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { Icon } from "../icons/Icon.tsx";
import { composeKey, composerNote, messageRoute, POST_OFF_CREDS, sendCommand, type ComposeTarget } from "../lib/compose.js";
import { formatRoute } from "../lib/route.js";
import type { Controller } from "../state/controller.js";
import { useStore } from "../state/hooks.js";
import type { Store } from "../state/store.js";
import type { DashboardState, Draft } from "../state/types.js";
import { CopyCommand } from "./CopyCommand.tsx";
import { clock } from "../lib/time.js";

/** The controller's two composer calls, for the composers the views draw. Null before the dashboard
 *  has started, when the box is read only and nothing sends. */
export const Compose = createContext<Pick<Controller, "send" | "draft"> | null>(null);

/** The parts of an element the composer uses. Spelled out rather than taken from the DOM lib, because
 *  the suites typecheck the components that render on the server with no DOM lib. */
type Field = { focus(): void; value: string };

/** The composer the next Message button asked to focus, by `composeKey`. The first composer for that
 *  target to mount takes it and clears it, a composer that cannot post included, so a request the
 *  view could not honour does not move the focus on a later visit. */
let wanted: string | null = null;
const askers = new Set<() => void>();

/** Ask the composer for `target` to take the focus: the one on screen now, or the one the next view
 *  draws. Message buttons call it as their link opens the DM view. */
export function focusComposer(target: ComposeTarget): void {
  wanted = composeKey(target);
  for (const ask of askers) ask();
}

/** Our own copy with backticks around inline code. Never server text. */
const withCode = (text: string): ReactNode[] => text.split("`").map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));

/** A target nothing has been typed for. */
const BLANK: Draft = { text: "", outgoing: [] };

/** The composer (mock section B, the four composer states, and section D's dock): the card and the
 *  note line under it, the same two elements in every state so the dock keeps one height.
 *
 *  - Nothing until `/api/meta` has said what the dashboard can post as.
 *  - Posting off: the reason with a lock, the command that posts from a terminal, a disabled send
 *    whose tooltip is the reason, and the note from `composerNote`.
 *  - Live: the box (`Message <where>`), Mention, the mode dot with `to`, "as operator", and send.
 *    Enter sends and Shift+Enter starts a new line.
 *  - Sending: send is disabled and spins until the server answers.
 *  - Refused: the draft is back in the box, the card is ringed, Try again replaces the row, and the
 *    note is the refusal, as plain text: the server's part of it is not ours to format.
 *
 *  `where` is `#review` or the agent's name; `to` is the mode line, `to #review · 5 members`. */
export function Composer({ store, target, where, to }: { store: Store<DashboardState>; target: ComposeTarget; where: string; to: string }) {
  const key = composeKey(target);
  const post = useStore(store, (s) => s.post);
  const draft = useStore(store, (s) => s.drafts[key]) ?? BLANK;
  const ctl = useContext(Compose);
  const box = useRef<HTMLTextAreaElement>(null);
  const field = () => box.current as unknown as Field | null;
  useLayoutEffect(() => {
    const take = () => {
      if (wanted !== key) return;
      wanted = null;
      field()?.focus();
    };
    take();
    askers.add(take);
    return () => void askers.delete(take);
  }, [key, post]);
  if (post === null) return null;

  if (post.mode === "off") {
    return (
      <>
        <div className="ui-card ui-composer" aria-disabled="true">
          <div className="ui-reason">
            <Icon icon={SquareLock02Icon} size={16} className="ui-ic ui-ic16" />
            <span>{post.reason === POST_OFF_CREDS ? withCode("This dashboard was started with `--creds`, which can only read.") : post.reason}</span>
          </div>
          <div className="ui-crow">
            <CopyCommand command={sendCommand(target)} />
            <span className="ui-sp" />
            <button type="button" className="ui-send" disabled title={post.reason} aria-label="Send">
              <Icon icon={ArrowUp02Icon} size={16} className="ui-ic ui-ic16" />
            </button>
          </div>
        </div>
        <div className="ui-cnote">{withCode(composerNote(post))}</div>
      </>
    );
  }

  const sending = draft.outgoing.some((o) => o.id === undefined);
  const refused = draft.refused;
  const ready = ctl !== null && !sending && draft.text.trim() !== "";
  const submit = () => {
    // The refusal is in the store; the rethrow is for callers that wait on the post.
    if (ready) ctl.send(target, draft.text).catch(() => undefined);
  };
  const mention = () => {
    ctl?.draft(target, `${draft.text}@`);
    field()?.focus();
  };
  return (
    <>
      <div className={refused === undefined ? "ui-card ui-composer" : "ui-card ui-composer ui-composer-err"}>
        <textarea
          ref={box}
          className={draft.text === "" ? "ui-input" : "ui-input ui-input-typed"}
          placeholder={`Message ${where}`}
          aria-label={`Message ${where}`}
          value={draft.text}
          readOnly={ctl === null}
          onChange={(e) => ctl?.draft(target, (e.currentTarget as unknown as Field).value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || (e.nativeEvent as { isComposing?: boolean }).isComposing) return;
            e.preventDefault();
            submit();
          }}
        />
        <div className="ui-crow">
          {refused === undefined ? (
            <>
              <button type="button" className="ui-pick" disabled={ctl === null} onClick={mention}>
                <Icon icon={AtIcon} size={16} className="ui-ic" />
                Mention
              </button>
              <span className="ui-sp" />
              <span className="ui-pick">
                <i className="ui-mode-dot" style={{ background: target.kind === "msg" ? "var(--multi)" : "var(--uni)" }} />
                {to}
              </span>
              <span className="ui-pick">as operator</span>
              <button type="button" className="ui-send" title={sending ? "Sending" : "Send"} aria-label={sending ? "Sending" : "Send"} disabled={!ready} onClick={submit}>
                {sending ? <span className="ui-spin" /> : <Icon icon={ArrowUp02Icon} size={16} className="ui-ic ui-ic16" />}
              </button>
            </>
          ) : (
            <>
              <span className="ui-sp" />
              <button type="button" className="ui-btn ui-btn-sm" disabled={!ready} onClick={submit}>Try again</button>
            </>
          )}
        </div>
      </div>
      {refused === undefined ? (
        <div className="ui-cnote">{withCode(composerNote(post))}</div>
      ) : (
        <div className="ui-cnote ui-cnote-err" role="alert" title={refused}>{refused}</div>
      )}
    </>
  );
}

/** The operator's posts to `target` that the view does not show yet (mock section B, sending then
 *  sent): faded while the server has not answered, then plain until the message itself arrives.
 *  `shown` is the ids the view already draws. The text is drawn as typed, not as Markdown. */
export function OutgoingRows({ store, target, shown }: { store: Store<DashboardState>; target: ComposeTarget; shown: ReadonlySet<string> }) {
  const draft = useStore(store, (s) => s.drafts[composeKey(target)]) ?? BLANK;
  return (
    <>
      {draft.outgoing.filter((o) => o.id === undefined || !shown.has(o.id)).map((o) => {
        const at = new Date(o.ts);
        return (
          <div key={o.seq} className={o.id === undefined ? "ui-msg ui-pending" : "ui-msg"}>
            <div className="ui-gut"><span className="ui-me" style={{ width: 34, height: 34 }}>OP</span></div>
            <div>
              <div className="ui-mh"><b>operator</b><span className="ui-role">operator</span><time dateTime={at.toISOString()}>{clock(at)}</time></div>
              <div className="ui-tx"><p style={{ whiteSpace: "pre-wrap" }}>{o.text}</p></div>
            </div>
          </div>
        );
      })}
    </>
  );
}

/** In the dock of a conversation between two agents, which the operator is not in (mock B's dock
 *  size): one line saying so, and Message, which opens the operator's own conversation with `peer`
 *  with its composer focused. The same two elements as the composer, so the dock keeps its height. */
export function BetweenAgents({ peer, name, selfId }: { peer: string; name: string; selfId: string | null }) {
  return (
    <>
      <div className="ui-card ui-composer">
        <div className="ui-reason"><span>This conversation is between two agents.</span></div>
        <div className="ui-crow">
          <span className="ui-sp" />
          <a className="ui-btn ui-btn-sm" href={formatRoute(messageRoute(peer, selfId))} onClick={() => focusComposer({ kind: "dm", to: peer })}>{`Message ${name}`}</a>
        </div>
      </div>
      <div className="ui-cnote" />
    </>
  );
}
