import { ArrowUpRight01Icon, BubbleChatIcon, HashtagIcon } from "@hugeicons/core-free-icons";
import type { CotalMessage } from "../../api/types.js";
import { Icon } from "../../icons/Icon.tsx";
import { partsToText } from "../../lib/parts.js";
import { formatRoute } from "../../lib/route.js";
import { Prose } from "../work/Prose.tsx";
import { Time } from "./Time.tsx";

/** The agent's own verified message, placed by its time and never joined to a `cotal_send` or
 *  `cotal_dm` call (mock B1, `ox-post`).
 *
 *  - A channel post (`channel`): the hash, "Posted in #<channel>", the time, "Open in #<channel>" to
 *    the channel, and the blue rule.
 *  - A direct message (`to`): the bubble, "Sent to <toName>" (the roster's name for `to`), the time,
 *    "Open conversation" to the conversation between `agent` and `to`, and the orange rule.
 *
 *  The body goes through `Prose`. The panel (`compact`) leaves the link out and the clamping to its CSS.
 *  `highlight` marks the post a reader arrived from. */
export function PostRow({ msg, agent, channel, to, toName, compact = false, highlight = false }: {
  msg: CotalMessage;
  agent: string;
  channel?: string;
  to?: string;
  toName?: string;
  compact?: boolean;
  highlight?: boolean;
}) {
  const dm = channel === undefined;
  const classes = ["ox-post", dm && "ox-post-dm", highlight && "ox-post-hl"].filter(Boolean).join(" ");
  const href = dm ? formatRoute({ view: "dm", peer: agent, ...(to === undefined ? {} : { with: to }) }) : formatRoute({ view: "channel", channel });
  return (
    <div className={classes} data-post={msg.id}>
      <div className="ox-post-h">
        <Icon icon={dm ? BubbleChatIcon : HashtagIcon} size={16} />
        <span>{dm ? `Sent to ${toName ?? to ?? ""}` : `Posted in #${channel}`}</span>
        <Time ts={msg.ts} />
        {!compact && (
          <>
            <span className="ui-sp" />
            <a className="ox-act" href={href}>
              {dm ? "Open conversation" : `Open in #${channel}`}
              <Icon icon={ArrowUpRight01Icon} size={16} />
            </a>
          </>
        )}
      </div>
      <Prose className="ui-tx" src={partsToText(msg.parts)} clamp={!compact} />
    </div>
  );
}
