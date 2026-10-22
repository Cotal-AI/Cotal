import { ArrowUpRight01Icon, Copy01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CotalMessage } from "../api/types.js";
import { Icon } from "../icons/Icon.tsx";
import { partsToText } from "../lib/parts.js";
import type { RosterRow } from "../lib/roster.js";
import { formatRoute } from "../lib/route.js";
import { Avatar } from "./Avatar.tsx";
import { copy } from "./CopyCommand.tsx";
import { FocusTrap } from "./focusTrap.tsx";
import { useBadgeOf } from "./identity.js";
import { hhmm } from "../lib/time.js";

/** A touch held this long on a message opens its actions. */
export const LONG_PRESS_MS = 500;
/** A touch that moves further than this is a scroll, not a press. */
export const PRESS_SLOP_PX = 8;
/** How long after a fired press lifts its own click may still arrive. A click later than this is a
 *  new one, so it goes through. */
export const PRESS_CLICK_MS = 100;

/** The parts of a pointer event and of an element the long press uses. Spelled out rather than
 *  taken from the DOM lib, because the suites typecheck the components that render on the server
 *  with no DOM lib. */
type Press = { pointerType: string; pointerId: number; clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void };
type Listens = {
  addEventListener(type: string, listener: (e: Press) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (e: Press) => void, capture?: boolean): void;
};
type Child = { parentElement: Listens | null };
type Page = { document: { body: unknown } };

/** A touch held `LONG_PRESS_MS` on the element around `child` (the message row) calls `onPress`. A
 *  mouse or a pen never does: they have the hover action. Moving more than `PRESS_SLOP_PX`, lifting
 *  or a cancelled pointer ends the press. The click that ends a press that fired is the press's, so
 *  it does not also follow a link or open the sender under the finger. A browser may send no click
 *  after a long press, so that hold lasts only `PRESS_CLICK_MS` past the lift, and a later click (Enter
 *  on the View work link) goes through. */
function useLongPress(child: { current: unknown }, onPress: () => void): void {
  const press = useRef(onPress);
  press.current = onPress;
  useEffect(() => {
    const row = (child.current as Child | null)?.parentElement;
    if (!row) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let start: { id: number; x: number; y: number } | undefined;
    let fired = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
      start = undefined;
    };
    const down = (e: Press) => {
      fired = false;
      cancel();
      if (e.pointerType !== "touch") return;
      start = { id: e.pointerId, x: e.clientX, y: e.clientY };
      timer = setTimeout(() => {
        timer = undefined;
        start = undefined;
        fired = true;
        press.current();
      }, LONG_PRESS_MS);
    };
    const move = (e: Press) => {
      if (start === undefined || e.pointerId !== start.id) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > PRESS_SLOP_PX) cancel();
    };
    const up = (e: Press) => {
      if (start !== undefined && e.pointerId === start.id) cancel();
      if (!fired) return;
      clearTimeout(settle);
      settle = setTimeout(() => { fired = false; }, PRESS_CLICK_MS);
    };
    const click = (e: Press) => {
      if (!fired) return;
      fired = false;
      e.preventDefault();
      e.stopPropagation();
    };
    // A held touch also asks the browser for its own menu; the sheet is this row's menu.
    const menu = (e: Press) => {
      if (timer !== undefined || fired) e.preventDefault();
    };
    row.addEventListener("pointerdown", down);
    row.addEventListener("pointermove", move);
    row.addEventListener("pointerup", up);
    row.addEventListener("pointercancel", up);
    row.addEventListener("click", click, true);
    row.addEventListener("contextmenu", menu);
    return () => {
      cancel();
      clearTimeout(settle);
      row.removeEventListener("pointerdown", down);
      row.removeEventListener("pointermove", move);
      row.removeEventListener("pointerup", up);
      row.removeEventListener("pointercancel", up);
      row.removeEventListener("click", click, true);
      row.removeEventListener("contextmenu", menu);
    };
  }, [child]);
}

/** The hover action row, and on touch the long-press sheet (agents mock S3, C "Focus", D and E).
 *
 *  - The action row (`ui-msg-acts`) holds one link, View work, to the sender's page at this message
 *    (`#/agent/<id>/work/<message id>`), titled "View <name>'s work at <hh:mm>". It shows on hover and
 *    while it holds focus, and stays in the tab order.
 *  - A touch held on the row opens a bottom sheet: the sender, "Message at <hh:mm>", then the same
 *    link, View agent (`onViewAgent`) and Copy text. It holds focus while open and closes on the
 *    scrim, on Escape or on any choice. It is drawn on the page's body, outside the row, so a press
 *    inside it is not a press on the row.
 *
 *  The caller draws it only for a verified sender on the roster (`peer`, the roster's row for
 *  `senderId`); `name` is that sender's name. A history row has no verified sender and gets none. */
export function MessageActions({ msg, senderId, name, peer, onViewAgent }: {
  msg: CotalMessage;
  senderId: string;
  name: string;
  peer: RosterRow;
  onViewAgent: (id: string) => void;
}) {
  const [sheet, setSheet] = useState(false);
  const acts = useRef<HTMLDivElement>(null);
  useLongPress(acts, () => setSheet(true));
  const at = hhmm(msg.ts);
  const href = formatRoute({ view: "agent", id: senderId, tab: "work", at: msg.id });
  return (
    <>
      <div ref={acts} className="ui-msg-acts">
        <a href={href} title={at ? `View ${name}'s work at ${at}` : `View ${name}'s work`}>
          <Icon icon={ArrowUpRight01Icon} size={16} className="ui-ic ui-ic16" />
          View work
        </a>
      </div>
      {sheet && (
        <ActionSheet msg={msg} senderId={senderId} name={name} peer={peer} at={at} href={href} onViewAgent={onViewAgent} onClose={() => setSheet(false)} />
      )}
    </>
  );
}

/** The long-press sheet (mock D, the first phone), on the page's body. */
function ActionSheet({ msg, senderId, name, peer, at, href, onViewAgent, onClose }: {
  msg: CotalMessage;
  senderId: string;
  name: string;
  peer: RosterRow;
  at: string | undefined;
  href: string;
  onViewAgent: (id: string) => void;
  onClose: () => void;
}) {
  const badgeOf = useBadgeOf();
  const label = useId();
  // Only a press that starts on the scrim closes the sheet, so the end of the press that opened it
  // does not close it again.
  const onScrim = useRef(false);
  const body = (globalThis as unknown as Page).document.body as Parameters<typeof createPortal>[1];
  return createPortal(
    <FocusTrap onEscape={onClose}>
      <div
        className="ui-msg-scrim"
        onPointerDown={(e) => { onScrim.current = e.target === e.currentTarget; }}
        onClick={(e) => {
          if (e.target === e.currentTarget && onScrim.current) onClose();
          onScrim.current = false;
        }}
      />
      <div className="ui-card ui-msg-sheet" role="dialog" aria-modal="true" aria-labelledby={label}>
        <div className="ui-msg-sheet-h" id={label}>
          <Avatar vendor={peer.harness} status={peer.status} size={28} dot={false} badge={badgeOf(senderId)} />
          <div>
            <b>{name}</b>
            <div className="ui-msg-sheet-sub">{at ? `Message at ${at}` : "Message"}</div>
          </div>
        </div>
        <a className="ui-row" href={href} onClick={onClose}>
          <Icon icon={ArrowUpRight01Icon} className="ui-ic" />
          <span className="ui-row-lbl">{`View ${name}'s work here`}</span>
        </a>
        <button type="button" className="ui-row" onClick={() => { onClose(); onViewAgent(senderId); }}>
          <Icon icon={UserGroupIcon} className="ui-ic" />
          <span className="ui-row-lbl">View agent</span>
        </button>
        <button type="button" className="ui-row" onClick={() => { copy(partsToText(msg.parts)); onClose(); }}>
          <Icon icon={Copy01Icon} className="ui-ic" />
          <span className="ui-row-lbl">Copy text</span>
        </button>
      </div>
    </FocusTrap>,
    body,
  );
}
