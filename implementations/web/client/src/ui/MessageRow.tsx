import { useState } from "react";
import type { CotalMessage, FeedMessage } from "../api/types.js";
import { HARNESS } from "../lib/harness.js";
import { renderMarkdown } from "../lib/md.js";
import { displayNameOf, type NameIndex } from "../lib/names.js";
import { partsToText } from "../lib/parts.js";
import type { RosterRow } from "../lib/roster.js";
import { Avatar } from "./Avatar.tsx";

/** Bodies longer than this many characters of source text clamp, with Show more. */
const CLAMP = 280;

/** The tooltip on a row read from history, which carries no verified sender. */
const UNVERIFIED =
  "History does not record who sent this message. The sender shown is the one the message names, and it has not been checked.";

/** The name a harness goes by, for the chip beside the sender. A connector the dashboard has no
 *  brand for is shown as the connector reports it. */
function harnessName(connector: string): string {
  const key = connector === "claude-code" ? "claude" : connector;
  return Object.hasOwn(HARNESS, key) ? HARNESS[key as keyof typeof HARNESS].label : connector;
}

/** `hh:mm` in the reader's own clock. */
const clock = (d: Date): string => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** One message, as mock section D draws it: the sender's character in the gutter, the header
 *  (name, role, harness, time), the body, and for an anycast the route chip.
 *
 *  - The sender is `senderId`, the publisher the server verified, and only for a history row (which
 *    has none) the payload's `from.id`. Its name, role and harness come from the roster by that id;
 *    the payload's `from.name` is never read. A history row says its sender is unverified.
 *  - The body is the parts' text rendered as sanitized Markdown, clamped past 280 characters.
 *  - An anycast names its claimer only when `claim` (an id, from `claimedBy`) is given: the wire has
 *    no claim event, so with no reply there is nothing to say.
 *  - A row whose mentions include `mention` (the reader's own name) is highlighted.
 *  - `compact` draws a continuation of the row above: no avatar and no header. */
export function MessageRow({ msg, senderId, mode, idx, peers, compact = false, mention, claim }: {
  msg: CotalMessage;
  senderId?: string;
  mode: FeedMessage["mode"];
  idx: NameIndex;
  /** Roster rows by id, offline included, for the sender's character, role and harness. */
  peers: ReadonlyMap<string, RosterRow>;
  compact?: boolean;
  mention?: string;
  claim?: string;
}) {
  const [opened, setOpened] = useState(false);
  const who = senderId ?? msg.from?.id;
  const peer = who === undefined ? undefined : peers.get(who);
  const text = partsToText(msg.parts);
  const clamped = !opened && text.length > CLAMP;
  const mentioned = mention !== undefined && (msg.mentions ?? []).includes(mention.toLowerCase());
  const role = typeof msg.toService === "string" ? msg.toService : undefined;
  const at = Number.isFinite(msg.ts) ? new Date(msg.ts) : undefined;
  const className = ["ui-msg", compact && "ui-msg-cont", mentioned && "ui-msg-mention"].filter(Boolean).join(" ");
  return (
    <div className={className}>
      <div className="ui-gut">{!compact && <Avatar vendor={peer?.harness} status={peer?.status ?? "offline"} size={34} dot={false} />}</div>
      <div>
        {!compact && (
          <div className="ui-mh">
            <b>{displayNameOf(senderId ?? msg.from, idx)}</b>
            {senderId === undefined && <span className="ui-unverified" title={UNVERIFIED}>unverified</span>}
            {peer?.role && <span className="ui-role">{peer.role}</span>}
            {peer?.harness && <span className="ui-hz">{harnessName(peer.harness)}</span>}
            {at && <time dateTime={at.toISOString()}>{clock(at)}</time>}
          </div>
        )}
        <div className={clamped ? "ui-tx ui-clamp" : "ui-tx"} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
        {clamped && <button type="button" className="ui-more" onClick={() => setOpened(true)}>Show more</button>}
        {mode === "anycast" && role !== undefined && (
          <div className="ui-route ui-route-any" title="Anycast: one free agent with this role takes it.">
            <i />
            {`To any ${role}`}
            {claim !== undefined && <><span className="ui-route-sep">·</span>{`claimed by ${displayNameOf(claim, idx)}`}</>}
          </div>
        )}
      </div>
    </div>
  );
}
