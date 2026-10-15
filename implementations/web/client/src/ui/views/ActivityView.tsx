import { Alert02Icon } from "@hugeicons/core-free-icons";
import { useMemo, useState } from "react";
import type { ActivityEntry, FeedMessage } from "../../api/types.js";
import { Icon } from "../../icons/Icon.tsx";
import { claimedBy } from "../../lib/claims.js";
import { displayNameOf, nameIndex, type NameIndex } from "../../lib/names.js";
import { rosterRows } from "../../lib/roster.js";
import { partialBanner } from "../../lib/shellText.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { DashboardState } from "../../state/types.js";
import { MessageRow } from "../MessageRow.tsx";
import { StaleMarker } from "../StaleMarker.tsx";
import { EmptySpace, hasAgents } from "./EmptySpace.tsx";

type Entry = ActivityEntry | FeedMessage;

/** The filter chips: everything, or one delivery mode (channel posts, direct messages, role requests). */
const FILTERS: { label: string; mode?: Entry["mode"] }[] = [
  { label: "All" },
  { label: "Channels", mode: "chat" },
  { label: "Direct", mode: "unicast" },
  { label: "Roles", mode: "anycast" },
];

/** Where a message went, from the field the wire sets for its mode. A channel is the one the server
 *  took from the subject; a recipient is named from the roster by id. When the wire did not send the
 *  field there is no destination to show, and none is made up. */
function placeOf(e: Entry, idx: NameIndex): string | null {
  if (e.mode === "chat") return typeof e.channel === "string" ? `#${e.channel}` : null;
  if (e.mode === "anycast") return typeof e.msg.toService === "string" ? `to role ${e.msg.toService}` : null;
  return typeof e.msg.to === "string" ? `to ${displayNameOf(e.msg.to, idx)}` : null;
}

/** The banner over a partial page (mock section B, Partial): the marker, how many sources answered,
 *  which half of the feed the page holds, and the server's reasons on hover. */
function PartialBanner({ banner }: { banner: NonNullable<ReturnType<typeof partialBanner>> }) {
  return (
    <div className="s-banner" role="status" title={banner.title}>
      <Icon icon={Alert02Icon} size={18} className="ui-ic" />
      <div>
        <b>{banner.label}</b>
        {banner.count && <> <span>{banner.count}</span></>}
        {banner.body && <><br /><span>{banner.body}</span></>}
      </div>
    </div>
  );
}

/** All activity (the Activity frames of mock section B): the header with the stale marker and the
 *  filter chips, then every message the dashboard holds, newest first, each saying where it went. A
 *  row the live feed delivered carries its verified sender; a backfill row does not, and MessageRow
 *  says so. While the roster has no agents the empty space state sits above the list. While the
 *  activity read is partial a banner heads the list and says what the page is missing, and the header
 *  drops its copy of the marker, as mock B's partial frame does: the sidebar and the banner say it. */
export function ActivityView({ store }: { store: Store<DashboardState> }) {
  const activity = useStore(store, (s) => s.activity);
  const roster = useStore(store, (s) => s.roster);
  const space = useStore(store, (s) => s.space);
  const stale = useStore(store, (s) => s.stale);
  const partial = partialBanner(stale);
  const [filter, setFilter] = useState<Entry["mode"] | undefined>(undefined);
  const idx = useMemo(() => nameIndex(roster), [roster]);
  const rows = useMemo(() => rosterRows(roster, { includeOffline: true }), [roster]);
  const peers = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  // Claims read the replies that came after an anycast, so they are found in arrival order, before
  // the list is turned newest first.
  const listed = useMemo(() => {
    const later = activity.map((e) => ({ msg: e.msg, senderId: (e as FeedMessage).senderId }));
    return activity
      .map((e, i) => ({ e, claim: e.mode === "anycast" ? claimedBy(e.msg.id, later.slice(i + 1)) : undefined }))
      .reverse();
  }, [activity]);
  const shown = filter === undefined ? listed : listed.filter(({ e }) => e.mode === filter);
  return (
    <>
      <header className="ui-bar">
        <h1>Activity</h1>
        {!partial && <StaleMarker store={store} id={null} />}
        <span className="ui-sp" />
        <span className="v3-toggle" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.label} type="button" aria-pressed={filter === f.mode} onClick={() => setFilter(f.mode)}>{f.label}</button>
          ))}
        </span>
      </header>
      <div className="ui-scroll">
        {!hasAgents(roster) && <EmptySpace space={space} />}
        <div className="ui-col">
          {partial && <PartialBanner banner={partial} />}
          {shown.map(({ e, claim }) => {
            const senderId = (e as FeedMessage).senderId;
            return (
              <MessageRow
                key={`${e.msg.id}\u0001${senderId ?? ""}`}
                msg={e.msg}
                senderId={senderId}
                mode={e.mode}
                idx={idx}
                peers={peers}
                mention="operator"
                claim={claim}
                place={placeOf(e, idx)}
              />
            );
          })}
        </div>
      </div>
    </>
  );
}
