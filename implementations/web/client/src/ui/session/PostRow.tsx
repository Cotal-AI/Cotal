import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { CotalMessage } from "../../api/types.js";
import { Icon } from "../../icons/Icon.tsx";
import { renderMarkdown } from "../../lib/md.js";
import { partsToText } from "../../lib/parts.js";
import { formatRoute } from "../../lib/route.js";
import { Time } from "./Time.tsx";

/** The agent's own verified post on a channel, placed by its time (mock S, `ui-post`): "Posted in
 *  #<channel>", the time, the body through the sanitized Markdown, and in the full view a link back to
 *  the channel. It is never joined to a `cotal_send` call. `highlight` marks the post a reader arrived
 *  from. */
export function PostRow({ msg, channel, compact = false, highlight = false }: {
  msg: CotalMessage;
  channel: string;
  compact?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className={highlight ? "ui-post ui-post-hl" : "ui-post"} data-post={msg.id}>
      <div className="ui-post-h">
        <span>{`Posted in #${channel}`}</span>
        <Time ts={msg.ts} />
        {!compact && (
          <>
            <span className="ui-sp" />
            <a href={formatRoute({ view: "channel", channel })}>
              {`Open in #${channel}`}
              <Icon icon={ArrowUpRight01Icon} size={16} className="ui-ic" />
            </a>
          </>
        )}
      </div>
      <div className="ui-tx" dangerouslySetInnerHTML={{ __html: renderMarkdown(partsToText(msg.parts)) }} />
    </div>
  );
}
