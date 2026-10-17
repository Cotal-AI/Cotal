import { ArrowLeft01Icon, InformationCircleIcon, SidebarRightIcon, SquareLock02Icon, Wrench01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../icons/Icon.tsx";
import type { ComposeTarget } from "../../lib/compose.js";
import { displayNameOf, nameIndex } from "../../lib/names.js";
import { rosterRows, type RosterRow } from "../../lib/roster.js";
import { formatRoute, type Route } from "../../lib/route.js";
import { eventCount, foldSession, SESSION_EVENT_CAP, type SessionFrame } from "../../lib/session.js";
import { SESSION_LIMIT_MAX, type Controller } from "../../state/controller.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { DashboardState, SessionState, StoredMessage } from "../../state/types.js";
import { Avatar } from "../Avatar.tsx";
import { Composer } from "../Composer.tsx";
import { CopyCommand } from "../CopyCommand.tsx";
import { useBadgeOf } from "../identity.js";
import { harnessName } from "../MessageRow.tsx";
import { JumpButton } from "../session/JumpButton.tsx";
import { LiveChip } from "../session/LiveChip.tsx";
import { PlaneNote } from "../session/PlaneNote.tsx";
import type { RunErrorCondition } from "../session/RunError.tsx";
import { SessionEmpty } from "../session/SessionEmpty.tsx";
import { SessionList } from "../session/SessionList.tsx";
import { StatusWord } from "../Status.tsx";
import { usePinnedScroll } from "./ChannelView.tsx";

/** A reader within this many pixels of the bottom is following the session, as in ChannelView. */
const PINNED_PX = 24;
/** Stable empty lists, so the fold is not redone while no session is held. */
const NO_FRAMES: SessionFrame[] = [];
const NO_POSTS: StoredMessage[] = [];

/** The parts of the scroll box this view reads. Spelled out rather than taken from the DOM lib,
 *  because the suites typecheck the components that render on the server with no DOM lib. */
type Scroller = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null; scrollIntoView?(opts?: { block?: string }): void }>;
};

/** One view of `id`'s session on this page: open on mount, closed on unmount, in the same effect,
 *  so the store's count of views stays paired however React runs it. */
export function useSession(controller: Controller | null, id: string): void {
  useEffect(() => {
    if (!controller) return;
    controller.openSession(id);
    return () => controller.closeSession(id);
  }, [controller, id]);
}

/** Presence's condition for the agent, taken only when its code is text: it is quoted on the page. */
function conditionOf(entry: DashboardState["roster"][number] | undefined): RunErrorCondition | undefined {
  const c = (entry as { condition?: { code?: unknown; since?: unknown } } | undefined)?.condition;
  if (typeof c !== "object" || c === null || typeof c.code !== "string") return undefined;
  return typeof c.since === "number" ? { code: c.code, since: c.since } : { code: c.code };
}

/** The skeleton rows of mock C, Loading. The bars are drawing, so assistive tech skips them. */
function SessionSkeleton() {
  const bar = (width: string, margin: string, height?: number) => (
    <span className="ui-skel" style={{ width, margin, ...(height === undefined ? {} : { height }) }} />
  );
  return (
    <div className="ui-col" aria-busy="true">
      <div aria-hidden="true">
        {bar("30%", "16px 0 14px")}
        {bar("92%", "0 0 8px")}
        {bar("70%", "0 0 18px")}
        {bar("38%", "0 0 18px", 8)}
        {bar("86%", "0 0 8px")}
        {bar("54%", "0 0 18px")}
        {bar("30%", "0 0 18px", 8)}
        {bar("78%", "0 0 8px")}
      </div>
    </div>
  );
}

/** One agent's session as a centre view (agents mock S3 and C, `tpl-sessview`): it reads like a
 *  Claude Code transcript of that agent.
 *
 *  - The header: the crumb back to `back`, the avatar with its badge, the name, role and harness, the
 *    status pill, then Live or the jump to new steps, and the panel button. Live shows only when the
 *    read went through, the agent's card does not say its plane is off, and the agent is online. On a
 *    phone the crumb is the back button, the pill is left out, and Agent details opens the panel.
 *  - The list: the event plane note when the card says the plane is on, Load earlier while the channel
 *    holds more and the session is below the cap (or the cap line at it), the folded steps and the
 *    footer. A reload that holds frames keeps them on screen with a quiet loading line.
 *  - The states, first match wins: loading with nothing held (skeleton rows), refused (the broker's
 *    reason and the grant to copy), failed with nothing held (Try again), the plane off (only the
 *    agent's posts), and with no steps the plane on or the card silent.
 *  - Following: while the reader is at the bottom, new steps scroll into view. Scrolled up, the jump
 *    button counts the live steps that arrived since, and takes the reader back down.
 *  - Arriving at a message (`at`): once the steps hold that post, it is scrolled into view and marked,
 *    and following stops until the reader returns to the bottom. With no such post the view opens at
 *    the bottom.
 *  - The dock is the agent's direct message composer, read only when posting is off, as in DmView.
 *
 *  Names, role, status and harness come from the roster by id, never from a frame. */
export function SessionView({ store, controller, id, at, back, phone = false, onDetails, panelOpen = false, onTogglePanel }: {
  store: Store<DashboardState>;
  controller: Controller | null;
  id: string;
  at?: string;
  /** Where the crumb and the phone's back button go: the channel the reader came from, else Agents. */
  back: { label: string; route: Route };
  phone?: boolean;
  /** Phone: opens the Agent tab full screen. */
  onDetails?: () => void;
  panelOpen?: boolean;
  onTogglePanel?: () => void;
}) {
  useSession(controller, id);
  const roster = useStore(store, (s) => s.roster);
  const self = useStore(store, (s) => s.operatorId);
  const post = useStore(store, (s) => s.post);
  const session: SessionState | undefined = useStore(store, (s) => s.sessions[id]);
  const idx = useMemo(() => nameIndex(roster), [roster]);
  const entry = roster.find((p) => p.card.id === id);
  const known: RosterRow | undefined = useMemo(() => (entry ? rosterRows([entry], { includeOffline: true })[0] : undefined), [entry]);
  const name = known?.name ?? displayNameOf(id, idx, self);
  // An id the roster does not hold is drawn offline, with no heartbeat to report.
  const row: RosterRow = known ?? { id, name, status: "offline", ts: Number.NaN };
  const condition = useMemo(() => conditionOf(entry), [entry]);
  const badgeOf = useBadgeOf();
  const frames = session?.frames ?? NO_FRAMES;
  const posts = session?.posts ?? NO_POSTS;
  const steps = useMemo(() => foldSession(frames, posts), [frames, posts]);
  const target = useMemo((): ComposeTarget => ({ kind: "dm", to: id }), [id]);
  const sub = [known?.role, known?.harness && harnessName(known.harness)].filter(Boolean).join(" · ");
  const plane = known?.events;
  const load = session?.load ?? "loading";

  // FOLLOWING. The pinned scroll keeps a reader at the bottom there; `away` holds the steps on screen
  // when the reader left the bottom, so the jump button counts only the live steps after them.
  const tail = steps[steps.length - 1];
  const scroll = usePinnedScroll(id, `${tail?.key ?? ""}\u0002${steps.length}\u0002${load}`);
  const scroller = () => scroll.ref.current as unknown as Scroller | null;
  const [away, setAway] = useState<Set<string> | null>(null);
  const onScroll = () => {
    scroll.onScroll();
    const el = scroller();
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= PINNED_PX;
    if (bottom && away) setAway(null);
    else if (!bottom && !away) setAway(new Set(steps.map((s) => s.key)));
  };
  const fresh = away ? steps.filter((s) => s.live && !away.has(s.key)).length : 0;
  const jump = () => {
    const el = scroller();
    if (el) el.scrollTop = el.scrollHeight;
    setAway(null);
  };

  // ARRIVING AT A MESSAGE. Scrolled to once, when the post is first held; the scroll event that
  // follows unpins the reader, so new steps no longer pull the view away from it.
  const arrived = useRef<string | undefined>(undefined);
  const holdsAt = at !== undefined && steps.some((s) => s.kind === "post" && s.msg.id === at);
  useLayoutEffect(() => {
    if (!holdsAt || at === undefined || arrived.current === at) return;
    const el = scroller();
    if (!el) return;
    const found = Array.from(el.querySelectorAll("[data-post]")).find((p) => p.getAttribute("data-post") === at);
    if (!found) return;
    arrived.current = at;
    found.scrollIntoView?.({ block: "center" });
  });

  const live = load === "ok" && plane !== "off" && known !== undefined && known.status !== "offline";
  const events = eventCount(frames);
  const atCap = events >= SESSION_EVENT_CAP || (session?.limit ?? 0) >= SESSION_LIMIT_MAX;
  const more = session?.more === true && plane !== "off";
  const panelLabel = panelOpen ? "Close panel" : "Open panel";
  const backTitle = `Back to ${back.label}`;

  const list = (
    <>
      {plane === "on" && (
        <PlaneNote>{`What ${name} publishes on its event plane: its text, the names of the tools it calls, and where each turn starts and ends. It doesn't publish tool inputs, tool results or reasoning.`}</PlaneNote>
      )}
      {more && !atCap && (
        <div className="ui-cutoff">
          <button type="button" className="ui-btn ui-btn-sm" disabled={load === "loading"} onClick={() => void controller?.loadEarlier(id)}>Load earlier</button>
        </div>
      )}
      {more && atCap && <div className="ui-cutoff">Showing the newest 2,000 events</div>}
      {load === "loading" && <div className="ui-cutoff" role="status">Loading</div>}
      <SessionList steps={steps} row={row} condition={condition} highlight={at} />
    </>
  );

  let body;
  if (load === "loading" && steps.length === 0) {
    body = <SessionSkeleton />;
  } else if (load === "refused") {
    body = (
      <div className="ui-col">
        <SessionEmpty icon={SquareLock02Icon} title={`This dashboard can't read ${name}'s session`}>
          <p>{`The broker refused it: ${session?.reason ?? ""}.`}</p>
          {session?.grant && (
            <>
              <p>The mesh owner can grant a read on that channel:</p>
              <CopyCommand command={session.grant} />
            </>
          )}
        </SessionEmpty>
        {steps.length > 0 && <SessionList steps={steps} row={row} condition={condition} highlight={at} />}
      </div>
    );
  } else if (load === "failed") {
    const retry = (
      <button type="button" className="ui-btn ui-btn-sm" onClick={() => void controller?.reloadSession(id)}>Try again</button>
    );
    body = steps.length === 0 ? (
      <div className="ui-col">
        <SessionEmpty icon={InformationCircleIcon} title={`${name}'s session didn't load`}>
          <p>{session?.reason ?? ""}</p>
          {retry}
        </SessionEmpty>
      </div>
    ) : (
      <div className="ui-col">
        <PlaneNote>{`${name}'s session didn't load. ${session?.reason ?? ""} `}{retry}</PlaneNote>
        {list}
      </div>
    );
  } else if (plane === "off") {
    body = (
      <div className="ui-col">
        <PlaneNote>{`${name} publishes no session events, so this view shows only what ${name} posted.`}</PlaneNote>
        <SessionList steps={steps} row={row} condition={condition} highlight={at} />
      </div>
    );
  } else if (steps.length === 0 && plane === "on") {
    body = (
      <div className="ui-col">
        <SessionEmpty icon={Wrench01Icon} title="No turns yet">
          <p>{`${name}'s first turn shows here as soon as it starts.`}</p>
        </SessionEmpty>
      </div>
    );
  } else if (steps.length === 0) {
    body = (
      <div className="ui-col">
        <SessionEmpty icon={InformationCircleIcon} title={`Nothing has arrived from ${name} yet`}>
          <p>Agents started with <code>cotal spawn</code> publish one unless started with <code>--no-events</code>. An agent you started yourself may not publish one at all.</p>
        </SessionEmpty>
      </div>
    );
  } else {
    body = <div className="ui-col">{list}</div>;
  }

  return (
    <>
      <header className="ui-bar">
        {phone ? (
          <a className="ui-tool" href={formatRoute(back.route)} title={backTitle} aria-label={backTitle}>
            <Icon icon={ArrowLeft01Icon} className="ui-ic" />
          </a>
        ) : (
          <a className="ui-crumb" href={formatRoute(back.route)} title={backTitle}>
            <Icon icon={ArrowLeft01Icon} size={16} className="ui-ic" />
            {back.label}
          </a>
        )}
        <Avatar vendor={known?.harness} status={row.status} size={24} dot={false} badge={known ? badgeOf(id) : undefined} />
        <h1>{name}</h1>
        {sub && <span className="ui-topic">{sub}</span>}
        {!phone && known && <StatusWord row={known} />}
        <span className="ui-sp" />
        {fresh > 0 ? <JumpButton count={fresh} onJump={jump} /> : live && <LiveChip name={name} />}
        {phone ? (
          <button type="button" className="ui-tool" title="Agent details" aria-label="Agent details" disabled={!onDetails} onClick={onDetails}>
            <Icon icon={InformationCircleIcon} className="ui-ic" />
          </button>
        ) : (
          onTogglePanel && (
            <button type="button" className="ui-tool" title={panelLabel} aria-label={panelLabel} aria-pressed={panelOpen} onClick={onTogglePanel}>
              <Icon icon={SidebarRightIcon} className="ui-ic" />
            </button>
          )
        )}
      </header>
      <div className="ui-scroll" ref={scroll.ref} onScroll={onScroll}>
        {body}
      </div>
      {post && (
        <div className="ui-dock">
          <div className="ui-dock-in">
            <Composer store={store} target={target} where={name} to={`to ${name} · direct message`} />
          </div>
        </div>
      )}
    </>
  );
}
