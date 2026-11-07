import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { useContext, useState } from "react";
import type { CotalMessage, FeedMessage } from "../api/types.js";
import { Icon } from "../icons/Icon.tsx";
import { HARNESS } from "../lib/harness.js";
import { renderMarkdown } from "../lib/md.js";
import { displayNameOf, type NameIndex } from "../lib/names.js";
import { partsToText } from "../lib/parts.js";
import { clock } from "../lib/time.js";
import type { RosterRow } from "../lib/roster.js";
import { Badge } from "#client/ui/shadcn/badge.tsx";
import { Bubble, BubbleContent } from "#client/ui/shadcn/bubble.tsx";
import { Button } from "#client/ui/shadcn/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "#client/ui/shadcn/collapsible.tsx";
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from "#client/ui/shadcn/message.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#client/ui/shadcn/tooltip.tsx";
import { Avatar } from "./Avatar.tsx";
import { useBadgeOf } from "./identity.js";
import { MessageActions } from "./MessageActions.tsx";
import { AgentPicker } from "./panel/picker.js";

/** Bodies longer than this many characters of source text clamp, with Show more. */
const CLAMP = 280;

/** The tooltip on a sender read from history, which carries no verified sender: the author of a
 *  history row, or the claimer of an anycast whose reply came from history. */
export const UNVERIFIED =
  "History does not record who sent this message. The sender shown is the one the message names, and it has not been checked.";

/** What an anycast's route chip means. */
const ANYCAST = "Anycast: one free agent with this role takes it.";

/** The unverified mark: an outline Badge with `UNVERIFIED` as its Tooltip and its screen reader text. */
export function Unverified() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline">unverified<span className="ui-sr">{` ${UNVERIFIED}`}</span></Badge>
      </TooltipTrigger>
      <TooltipContent>{UNVERIFIED}</TooltipContent>
    </Tooltip>
  );
}

/** The name a harness goes by, for the Badge beside the sender. A connector the dashboard has no
 *  brand for is shown as the connector reports it. */
export function harnessName(connector: string): string {
  const key = connector === "claude-code" ? "claude" : connector;
  return Object.hasOwn(HARNESS, key) ? HARNESS[key as keyof typeof HARNESS].label : connector;
}

/** Where a row sits in a run of messages from one verified sender, which the caller draws as one
 *  `MessageGroup`: the first draws the header, the last the avatar, and a row alone draws both. */
export type RunPlace = "alone" | "first" | "middle" | "last";

/** One message, on shadcn's chat parts: `Message` with the sender's character in `MessageAvatar`,
 *  the header (name, role, harness, time) in `MessageHeader`, the body in a `Bubble`, and for an
 *  anycast the route chip in `MessageFooter`.
 *
 *  - The sender is `senderId`, the publisher the server verified, and only for a history row (which
 *    has none) the payload's `from.id`. Its name, role and harness come from the roster by that id;
 *    the payload's `from.name` is never read. A history row says its sender is unverified.
 *  - `own` is a post by the operator, the reader: it sits at the end side in the default, strong
 *    bubble. Every other row sits at the start side in a secondary bubble, and one whose mentions
 *    include `mention` (the reader's own name) in the tinted bubble, which is its highlight.
 *  - The body is the parts' text rendered as sanitized Markdown. Past 280 characters it clamps, and
 *    Show more and Show less toggle the rest through shadcn's Collapsible.
 *  - An anycast names its claimer only when `claim` (from `claimedBy`) is given: the wire has no claim
 *    event, so with no reply there is nothing to say. A claim from a history reply is not verified
 *    and carries the same unverified mark and tooltip as an unverified author.
 *  - `place`, when given (even as null), takes the role's place in the header and drops the harness.
 *  - Inside the shell (`AgentPicker`), a verified sender's avatar and name pick it: its Agent tab
 *    peek, or on a phone its page. A history row's sender is not verified, so it opens nothing.
 *  - A verified sender on the roster carries its initial badge (`BadgeOf`); a history row's does not.
 *  - A verified sender on the roster also gets the View work action (`MessageActions`): on hover, and
 *    on a phone a long press, to open its page's Work at this message. A history row gets none.
 *  - `run` places the row in a run from one sender (`RunPlace`). A history row ignores it and draws
 *    its header and avatar, so its unverified mark is never hidden behind the row above. */
export function MessageRow({ msg, senderId, mode, idx, peers, run = "alone", own = false, mention, claim, place }: {
  msg: CotalMessage;
  senderId?: string;
  mode: FeedMessage["mode"];
  idx: NameIndex;
  /** Roster rows by id, offline included, for the sender's character, role and harness. */
  peers: ReadonlyMap<string, RosterRow>;
  run?: RunPlace;
  own?: boolean;
  mention?: string;
  claim?: { id: string; verified: boolean };
  /** Where the message went (`#review`, `to reviewer_2`), drawn where the role goes, with no harness
   *  chip, as mock B's Activity rows draw it. The Activity view passes it, and passes null for a
   *  message whose destination the wire did not send, which then shows nothing in that place. */
  place?: string | null;
}) {
  const [opened, setOpened] = useState(false);
  const pick = useContext(AgentPicker);
  const badgeOf = useBadgeOf();
  const who = senderId ?? msg.from?.id;
  const peer = who === undefined ? undefined : peers.get(who);
  const text = partsToText(msg.parts);
  const long = text.length > CLAMP;
  const mentioned = mention !== undefined && (msg.mentions ?? []).includes(mention.toLowerCase());
  const role = typeof msg.toService === "string" ? msg.toService : undefined;
  const at = Number.isFinite(msg.ts) ? new Date(msg.ts) : undefined;
  // A history row never joins a run, so it draws its own header and avatar.
  const where = senderId === undefined ? "alone" : run;
  const html = { __html: renderMarkdown(text) };
  const name = displayNameOf(senderId ?? msg.from, idx);
  // Only a verified sender on the roster gets a badge: a history row's sender is unverified.
  const badge = senderId !== undefined && peers.has(senderId) ? badgeOf(senderId) : undefined;
  const avatar = <Avatar vendor={peer?.harness} status={peer?.status ?? "offline"} size={32} dot={false} badge={badge} />;
  return (
    <Message align={own ? "end" : "start"}>
      {/* The initial badge sits on the avatar's corner, so the round slot lets it overflow. */}
      <MessageAvatar className="overflow-visible">
        {(where === "alone" || where === "last") && (pick && senderId !== undefined ? (
          // The name above is the keyboard's way in, so the avatar is not a second tab stop.
          <button type="button" tabIndex={-1} aria-label={name} onClick={() => pick(senderId)}>{avatar}</button>
        ) : avatar)}
      </MessageAvatar>
      <MessageContent>
        {(where === "alone" || where === "first") && (
          <MessageHeader className="flex-wrap gap-2">
            {pick && senderId !== undefined ? (
              <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={() => pick(senderId)}>{name}</Button>
            ) : (
              <span>{name}</span>
            )}
            {senderId === undefined && <Unverified />}
            {place && <Badge variant="secondary">{place}</Badge>}
            {place === undefined && peer?.role && <Badge variant="secondary">{peer.role}</Badge>}
            {place === undefined && peer?.harness && <Badge variant="outline">{harnessName(peer.harness)}</Badge>}
            {at && <time dateTime={at.toISOString()}>{clock(at)}</time>}
          </MessageHeader>
        )}
        <Bubble variant={own ? "default" : mentioned ? "tinted" : "secondary"}>
          <BubbleContent>
            {long ? (
              <Collapsible open={opened} onOpenChange={setOpened}>
                {/* Always drawn, clamped while closed, so the trigger's aria-controls names it. */}
                <CollapsibleContent forceMount className={opened ? "ui-tx" : "ui-tx ui-clamp"} dangerouslySetInnerHTML={html} />
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost" size="xs">
                    {opened ? "Show less" : "Show more"}
                    <Icon icon={ArrowDown01Icon} data-icon="inline-end" className="group-data-open/button:rotate-180" />
                  </Button>
                </CollapsibleTrigger>
              </Collapsible>
            ) : (
              <div className="ui-tx" dangerouslySetInnerHTML={html} />
            )}
          </BubbleContent>
        </Bubble>
        {mode === "anycast" && role !== undefined && (
          <MessageFooter className="flex-wrap gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline">
                  <i className="ui-mode-dot" style={{ background: "var(--any)" }} />
                  {`To any ${role}`}
                  <span className="ui-sr">{` ${ANYCAST}`}</span>
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{ANYCAST}</TooltipContent>
            </Tooltip>
            {claim !== undefined && (
              <>
                <span>{` · claimed by ${displayNameOf(claim.id, idx)}`}</span>
                {!claim.verified && <Unverified />}
              </>
            )}
          </MessageFooter>
        )}
      </MessageContent>
      {senderId !== undefined && peer !== undefined && peers.has(senderId) && (
        <MessageActions msg={msg} senderId={senderId} name={name} peer={peer} onViewAgent={pick ?? ignore} />
      )}
    </Message>
  );
}

/** Outside the shell picking an agent opens nothing, as a row's name opens nothing there. */
const ignore = (): void => undefined;
