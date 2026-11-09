import { ArrowUpRight01Icon, Copy01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { useEffect, useId, useRef, useState } from "react";
import type { CotalMessage } from "../api/types.js";
import { Icon } from "../icons/Icon.tsx";
import { Button } from "#client/ui/shadcn/button.tsx";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "#client/ui/shadcn/sheet.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#client/ui/shadcn/tooltip.tsx";
import { partsToText } from "../lib/parts.js";
import type { RosterRow } from "../lib/roster.js";
import { formatRoute } from "../lib/route.js";
import { Avatar } from "./Avatar.tsx";
import { copy } from "./CopyCommand.tsx";
import { useBadgeOf } from "./identity.js";
import { useReturnFocus } from "./returnFocus.ts";
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
 *    (`#/agent/<id>/work/<message id>`), with "View <name>'s work at <hh:mm>" as its Tooltip and its
 *    accessible description. It shows on hover and while it holds focus, and stays in the tab order.
 *    It sits at the top end of the message's own box, where the scroller item around the message
 *    does not clip it.
 *  - A touch held on the row opens shadcn's Sheet from the bottom: the sender as its title, "Message
 *    at <hh:mm>" as its description, then the same link, View agent (`onViewAgent`) and Copy text. It
 *    holds focus while open and closes on the scrim, on Escape, on its Close button or on any choice,
 *    and focus goes back where it was. It is drawn on the page's body, outside the row, so a press
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
  const hint = at ? `View ${name}'s work at ${at}` : `View ${name}'s work`;
  const hintId = useId();
  return (
    <>
      <div ref={acts} className="ui-msg-acts">
        <Tooltip>
          <TooltipTrigger asChild>
            <a href={href} aria-describedby={hintId}>
              <Icon icon={ArrowUpRight01Icon} size={16} className="ui-ic ui-ic16" />
              View work
            </a>
          </TooltipTrigger>
          <TooltipContent>{hint}</TooltipContent>
        </Tooltip>
        <span id={hintId} className="ui-sr">{hint}</span>
      </div>
      <ActionSheet open={sheet} onOpenChange={setSheet} msg={msg} senderId={senderId} name={name} peer={peer} at={at} href={href} onViewAgent={onViewAgent} />
    </>
  );
}

/** The long-press sheet (mock D, the first phone). */
function ActionSheet({ open, onOpenChange, msg, senderId, name, peer, at, href, onViewAgent }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  msg: CotalMessage;
  senderId: string;
  name: string;
  peer: RosterRow;
  at: string | undefined;
  href: string;
  onViewAgent: (id: string) => void;
}) {
  const badgeOf = useBadgeOf();
  const returnFocus = useReturnFocus();
  const close = () => onOpenChange(false);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" {...returnFocus}>
        <SheetHeader className="flex-row items-center gap-3">
          <Avatar vendor={peer.harness} status={peer.status} size={28} dot={false} badge={badgeOf(senderId)} />
          <div className="flex flex-col gap-0.5">
            <SheetTitle>{name}</SheetTitle>
            <SheetDescription>{at ? `Message at ${at}` : "Message"}</SheetDescription>
          </div>
        </SheetHeader>
        <SheetFooter>
          <Button asChild variant="ghost" className="justify-start">
            <a href={href} onClick={close}>
              <Icon icon={ArrowUpRight01Icon} data-icon="inline-start" />
              {`View ${name}'s work here`}
            </a>
          </Button>
          <Button type="button" variant="ghost" className="justify-start" onClick={() => { close(); onViewAgent(senderId); }}>
            <Icon icon={UserGroupIcon} data-icon="inline-start" />
            View agent
          </Button>
          <Button type="button" variant="ghost" className="justify-start" onClick={() => { copy(partsToText(msg.parts)); close(); }}>
            <Icon icon={Copy01Icon} data-icon="inline-start" />
            Copy text
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
