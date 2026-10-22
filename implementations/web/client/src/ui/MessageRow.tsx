import { useContext, useState } from "react";
import type { CotalMessage, FeedMessage } from "../api/types.js";
import { HARNESS } from "../lib/harness.js";
import { renderMarkdown } from "../lib/md.js";
import { displayNameOf, type NameIndex } from "../lib/names.js";
import { partsToText } from "../lib/parts.js";
import { clock } from "../lib/time.js";
import type { RosterRow } from "../lib/roster.js";
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

/** The name a harness goes by, for the chip beside the sender. A connector the dashboard has no
 *  brand for is shown as the connector reports it. */
export function harnessName(connector: string): string {
  const key = connector === "claude-code" ? "claude" : connector;
  return Object.hasOwn(HARNESS, key) ? HARNESS[key as keyof typeof HARNESS].label : connector;
}

/** One message, as mock section D draws it: the sender's character in the gutter, the header
 *  (name, role, harness, time), the body, and for an anycast the route chip.
 *
 *  - The sender is `senderId`, the publisher the server verified, and only for a history row (which
 *    has none) the payload's `from.id`. Its name, role and harness come from the roster by that id;
 *    the payload's `from.name` is never read. A history row says its sender is unverified.
 *  - The body is the parts' text rendered as sanitized Markdown, clamped past 280 characters.
 *  - An anycast names its claimer only when `claim` (from `claimedBy`) is given: the wire has no claim
 *    event, so with no reply there is nothing to say. A claim from a history reply is not verified
 *    and carries the same unverified mark and tooltip as an unverified author.
 *  - A row whose mentions include `mention` (the reader's own name) is highlighted.
 *  - `place`, when given (even as null), takes the role's place in the header and drops the harness.
 *  - Inside the shell (`AgentPicker`), a verified sender's avatar and name pick it: its Agent tab
 *    peek, or on a phone its page. A history row's sender is not verified, so it opens nothing.
 *  - A verified sender on the roster carries its initial badge (`BadgeOf`); a history row's does not.
 *  - A verified sender on the roster also gets the View work action (`MessageActions`): on hover, and
 *    on a phone a long press, to open its page's Work at this message. A history row gets none.
 *  - `compact` draws a continuation of the row above: no avatar and no header. A caller that groups
 *    consecutive rows must break the run at a row with no `senderId`, and this component enforces it:
 *    a history row ignores `compact` and always draws its header, so its unverified mark is never
 *    hidden behind the row above. */
export function MessageRow({ msg, senderId, mode, idx, peers, compact = false, mention, claim, place }: {
  msg: CotalMessage;
  senderId?: string;
  mode: FeedMessage["mode"];
  idx: NameIndex;
  /** Roster rows by id, offline included, for the sender's character, role and harness. */
  peers: ReadonlyMap<string, RosterRow>;
  compact?: boolean;
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
  const clamped = !opened && text.length > CLAMP;
  const mentioned = mention !== undefined && (msg.mentions ?? []).includes(mention.toLowerCase());
  const role = typeof msg.toService === "string" ? msg.toService : undefined;
  const at = Number.isFinite(msg.ts) ? new Date(msg.ts) : undefined;
  const cont = compact && senderId !== undefined;
  const name = displayNameOf(senderId ?? msg.from, idx);
  // Only a verified sender on the roster gets a badge: a history row's sender is unverified.
  const badge = senderId !== undefined && peers.has(senderId) ? badgeOf(senderId) : undefined;
  const avatar = <Avatar vendor={peer?.harness} status={peer?.status ?? "offline"} size={34} dot={false} badge={badge} />;
  const className = ["ui-msg", cont && "ui-msg-cont", mentioned && "ui-msg-mention"].filter(Boolean).join(" ");
  return (
    <div className={className}>
      <div className="ui-gut">
        {!cont && (pick && senderId !== undefined ? (
          // The name beside it is the keyboard's way in, so the avatar is not a second tab stop.
          <button type="button" className="ui-who" tabIndex={-1} aria-label={name} onClick={() => pick(senderId)}>{avatar}</button>
        ) : avatar)}
      </div>
      <div>
        {!cont && (
          <div className="ui-mh">
            {pick && senderId !== undefined ? <button type="button" className="ui-who" onClick={() => pick(senderId)}><b>{name}</b></button> : <b>{name}</b>}
            {senderId === undefined && <span className="ui-unverified" title={UNVERIFIED}>unverified</span>}
            {place && <span className="ui-role">{place}</span>}
            {place === undefined && peer?.role && <span className="ui-role">{peer.role}</span>}
            {place === undefined && peer?.harness && <span className="ui-hz">{harnessName(peer.harness)}</span>}
            {at && <time dateTime={at.toISOString()}>{clock(at)}</time>}
          </div>
        )}
        <div className={clamped ? "ui-tx ui-clamp" : "ui-tx"} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
        {clamped && <button type="button" className="ui-more" onClick={() => setOpened(true)}>Show more</button>}
        {mode === "anycast" && role !== undefined && (
          <div className="ui-route ui-route-any" title="Anycast: one free agent with this role takes it.">
            <i />
            {`To any ${role}`}
            {claim !== undefined && (
              <>
                {" "}<span className="ui-route-sep">·</span>{" "}
                {`claimed by ${displayNameOf(claim.id, idx)}`}
                {!claim.verified && <>{" "}<span className="ui-unverified" title={UNVERIFIED}>unverified</span></>}
              </>
            )}
          </div>
        )}
      </div>
      {senderId !== undefined && peer !== undefined && peers.has(senderId) && (
        <MessageActions msg={msg} senderId={senderId} name={name} peer={peer} onViewAgent={pick ?? ignore} />
      )}
    </div>
  );
}

/** Outside the shell picking an agent opens nothing, as a row's name opens nothing there. */
const ignore = (): void => undefined;
