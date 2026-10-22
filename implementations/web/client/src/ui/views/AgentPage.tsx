import { ArrowDown02Icon, ArrowLeft01Icon, InformationCircleIcon, Message01Icon, SidebarRightIcon, SquareLock02Icon, Wrench01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../icons/Icon.tsx";
import { messageRoute, type ComposeTarget } from "../../lib/compose.js";
import { displayNameOf, nameIndex } from "../../lib/names.js";
import { rosterRows, statusLabel, type RosterRow } from "../../lib/roster.js";
import { formatRoute, type AgentTab, type Route } from "../../lib/route.js";
import { eventCount, foldWork, SESSION_EVENT_CAP, type SessionFrame, type Work, type WorkItem } from "../../lib/session.js";
import { SESSION_LIMIT_MAX, type Controller } from "../../state/controller.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { DashboardState, SessionState, StoredMessage } from "../../state/types.js";
import { AgentMessages, messageGroups } from "../agent/AgentMessages.tsx";
import { AgentProfile } from "../agent/AgentProfile.tsx";
import { Avatar } from "../Avatar.tsx";
import { Composer, focusComposer } from "../Composer.tsx";
import { CopyCommand } from "../CopyCommand.tsx";
import { useBadgeOf } from "../identity.js";
import { harnessName } from "../MessageRow.tsx";
import { PlaneNote } from "../session/PlaneNote.tsx";
import type { RunErrorCondition } from "../session/RunError.tsx";
import { SessionEmpty } from "../session/SessionEmpty.tsx";
import { Badge } from "../shadcn/badge.tsx";
import { Button } from "../shadcn/button.tsx";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport, useMessageScrollerScrollable } from "../shadcn/message-scroller.tsx";
import { Spinner } from "../shadcn/spinner.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../shadcn/tabs.tsx";
import { STATUS_ICON, word } from "../Status.tsx";
import { WorkList } from "../work/WorkList.tsx";

/** A reader within this many pixels of the bottom is following the work again. */
const PINNED_PX = 24;
/** Stable empty lists, so the fold is not redone while nothing is held. */
const NO_FRAMES: SessionFrame[] = [];
const NO_POSTS: StoredMessage[] = [];

/** One step of the work by key, whether it arrived live, and for a post its message id. */
interface StepKey { key: string; live: boolean; post?: string }

/** Every turn, step, call and loose item of `work` in order, by key, for the new-step count and the
 *  arrival. A run of calls is keyed by its first call, so that call is not listed twice. A post carries
 *  its message id. */
function stepsOf(work: Work): StepKey[] {
  return work.items.flatMap((item): WorkItem[] => (item.kind === "turn" ? [item, ...item.steps] : [item]))
    .flatMap((s) => [
      { key: s.key, live: s.live, ...(s.kind === "post" ? { post: s.msg.id } : {}) },
      ...(s.kind === "tools" ? s.calls.slice(1).map((c) => ({ key: c.key, live: c.live })) : []),
    ]);
}

/** The parts of the scroll box the page reads. Spelled out rather than taken from the DOM lib, because
 *  the suites typecheck the components that render on the server with no DOM lib. */
type Scroller = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null; scrollIntoView?(opts?: { block?: string }): void }>;
};

/** One view of `id`'s work on this page: open on mount, closed on unmount, in the same effect, so the
 *  store's count of views stays paired however React runs it. */
export function useSession(controller: Controller | null, id: string): void {
  useEffect(() => {
    if (!controller) return;
    controller.openSession(id);
    return () => controller.closeSession(id);
  }, [controller, id]);
}

/** Presence's condition for the agent, taken only when its code is text: it is quoted on the page. */
export function conditionOf(entry: DashboardState["roster"][number] | undefined): RunErrorCondition | undefined {
  const c = (entry as { condition?: { code?: unknown; since?: unknown } } | undefined)?.condition;
  if (typeof c !== "object" || c === null || typeof c.code !== "string") return undefined;
  return typeof c.since === "number" ? { code: c.code, since: c.since } : { code: c.code };
}

/** The agent's own verified messages for its work: the channel posts its session holds, then its
 *  direct messages from the page's DMs (`senderId === id`), each message once. A history row carries
 *  no sender, so it never counts. */
export function useOwnMessages(store: Store<DashboardState>, id: string): StoredMessage[] {
  const posts = useStore(store, (s) => s.sessions[id]?.posts) ?? NO_POSTS;
  const dms = useStore(store, (s) => s.dms);
  return useMemo(() => {
    const held = new Set(posts.map((p) => p.msg.id));
    const sent = dms.filter((m) => m.senderId === id && typeof m.msg.to === "string" && !held.has(m.msg.id));
    return sent.length === 0 ? posts : [...posts, ...sent];
  }, [posts, dms, id]);
}

/** The status in the page's header (mock B1, `sh-badge`): shadcn's Badge in the status's colour, with
 *  its icon and word. The working icon turns. */
function StatusBadge({ row }: { row: RosterRow }) {
  const icon = Object.hasOwn(STATUS_ICON, row.status) ? STATUS_ICON[row.status] : undefined;
  return (
    <Badge variant="secondary" className={`ox-badge ox-badge-${row.status}`}>
      <span className="ox-badge-i">
        {row.status === "working" ? <Spinner role={undefined} aria-hidden="true" /> : icon && <Icon icon={icon} size={16} />}
      </span>
      {word(statusLabel(row))}
    </Badge>
  );
}

/** The skeleton rows of mock C, Loading. The bars are drawing, so assistive tech skips them. */
function WorkSkeleton() {
  const bar = (width: string) => <span className="ui-skel" style={{ width }} />;
  return (
    <div className="ox-col ox-skel" aria-busy="true">
      <div aria-hidden="true">
        {bar("36%")}
        {bar("88%")}
        {bar("64%")}
        {bar("42%")}
        {bar("30%")}
        {bar("76%")}
      </div>
    </div>
  );
}

/** The scroller's button while the reader is away from the bottom: how many steps arrived live below
 *  since they left it, and a click back down. It draws only once one has. `away` says the page itself
 *  stopped following (an arrival at a message), which the scroller does not see as the reader's own
 *  scroll. */
function NewSteps({ steps, away }: { steps: readonly StepKey[]; away: boolean }) {
  const { end } = useMessageScrollerScrollable();
  const [seen, setSeen] = useState<Set<string> | null>(null);
  const up = end || away;
  if (up && seen === null) setSeen(new Set(steps.map((s) => s.key)));
  if (!up && seen !== null) setSeen(null);
  const fresh = seen ? steps.filter((s) => s.live && !seen.has(s.key)).length : 0;
  if (fresh === 0) return null;
  return (
    <MessageScrollerButton variant="outline" size="sm" className="ox-newsteps">
      <Icon icon={ArrowDown02Icon} size={16} />
      {fresh === 1 ? "1 new step" : `${fresh} new steps`}
    </MessageScrollerButton>
  );
}

/** Go to another tab of this agent's page. Setting the hash adds a history entry, so back returns to
 *  the tab before and a reload keeps the tab. */
function goTo(route: Route): void {
  (globalThis as unknown as { location: { hash: string } }).location.hash = formatRoute(route);
}

/** One agent as a place (overhaul mock B1, C, D and E): `#/agent/<id>` with Work, Messages and
 *  Profile tabs.
 *
 *  - The header: the crumb back to `back` with its label, the avatar with its badge, the name, role
 *    and harness, the status Badge (the working icon turns), Message to the operator's conversation
 *    with the agent with its composer focused, and the panel button. On a phone the crumb is the back
 *    button, the role and harness are left out and Message is an icon.
 *  - The tabs are the route: a tab change writes `#/agent/<id>/<tab>`, so back and reload keep it.
 *    Messages carries the count of the posts and direct messages it lists.
 *  - Work: the agent's work as turns (`WorkList`) over its frames and its own posts and DMs, in shadcn's
 *    Message Scroller. While the reader is at the bottom new steps scroll into view; scrolled up, the
 *    scroller's button counts the live steps that arrived since. Load earlier, the cap line and a
 *    quiet loading line sit above the list.
 *  - Work's states, first match wins: loading with nothing held (skeleton rows), refused (the broker's
 *    reason and the grant to copy), failed with nothing held (Try again) or with steps (the line above
 *    the list), the plane off (the note, then the agent's posts), and with no steps the plane on or
 *    the card silent.
 *  - Arriving at a message (`at`): once the steps hold that post and no read is in flight, its turn
 *    opens, it is scrolled to the middle and marked, and following stops until the reader returns to
 *    the bottom. With no such post the page opens at the bottom.
 *  - The dock is the agent's direct message composer on every tab, read only when posting is off.
 *
 *  Names, role, status and harness come from the roster by id, never from a frame. */
export function AgentPage({ store, controller, id, tab, at, back, phone = false, panelOpen = false, onTogglePanel }: {
  store: Store<DashboardState>;
  controller: Controller | null;
  id: string;
  tab: AgentTab;
  at?: string;
  /** Where the crumb and the phone's back button go: the place the reader came from, else Agents. */
  back: { label: string; route: Route };
  phone?: boolean;
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
  const posts = useOwnMessages(store, id);
  const work = useMemo(() => foldWork(frames, posts), [frames, posts]);
  const steps = useMemo(() => stepsOf(work), [work]);
  const groups = useMemo(() => messageGroups(posts), [posts]);
  const count = groups.reduce((n, g) => n + g.rows.length, 0);
  const nameOf = useMemo(() => (who: string) => displayNameOf(who, idx, self), [idx, self]);
  const target = useMemo((): ComposeTarget => ({ kind: "dm", to: id }), [id]);
  const sub = [known?.role, known?.harness && harnessName(known.harness)].filter(Boolean).join(" · ");
  const plane = known?.events;
  const load = session?.load ?? "loading";

  // FOLLOWING. The scroller follows the bottom by itself; the page turns that off only after an
  // arrival, and back on once the reader is at the bottom again.
  const [following, setFollowing] = useState(true);
  // Work opens again at the bottom after another tab, so it follows again.
  if (tab !== "work" && !following) setFollowing(true);
  const viewport = useRef<HTMLDivElement>(null);
  const scroller = () => viewport.current as unknown as Scroller | null;
  const onScroll = () => {
    const el = scroller();
    if (following || !el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= PINNED_PX) setFollowing(true);
  };

  // ARRIVING AT A MESSAGE. Once, when the post is held and no read is in flight: the posts are often
  // held before the history read lands, and the scroller takes the view to the bottom when it does.
  // This effect runs after the scroller's own, and stops the following, so neither that read nor a new
  // step pulls the view away from the post.
  const arrived = useRef<string | undefined>(undefined);
  const holdsAt = at !== undefined && steps.some((s) => s.post === at);
  useLayoutEffect(() => {
    if (!holdsAt || at === undefined || arrived.current === at || load === "loading") return;
    const el = scroller();
    if (!el) return;
    const found = Array.from(el.querySelectorAll("[data-post]")).find((p) => p.getAttribute("data-post") === at);
    if (!found) return;
    arrived.current = at;
    setFollowing(false);
    found.scrollIntoView?.({ block: "center" });
  });

  const events = eventCount(frames);
  const atCap = events >= SESSION_EVENT_CAP || (session?.limit ?? 0) >= SESSION_LIMIT_MAX;
  const more = session?.more === true && plane !== "off";
  const panelLabel = panelOpen ? "Close panel" : "Open panel";
  const backTitle = `Back to ${back.label}`;
  const messageHref = formatRoute(messageRoute(id, self));
  const focus = () => focusComposer(target);
  const list = <WorkList work={work} row={row} condition={condition} highlight={at} nameOf={nameOf} />;

  let body;
  if (load === "loading" && steps.length === 0) {
    body = <WorkSkeleton />;
  } else if (load === "refused") {
    body = (
      <div className="ox-col">
        <SessionEmpty icon={SquareLock02Icon} title={`This dashboard can't read ${name}'s work`}>
          <p>{`The broker refused it: ${session?.reason ?? ""}.`}</p>
          {session?.grant && (
            <>
              <p>The mesh owner can grant a read on that channel:</p>
              <CopyCommand command={session.grant} />
            </>
          )}
        </SessionEmpty>
        {steps.length > 0 && list}
      </div>
    );
  } else if (load === "failed" && steps.length === 0) {
    body = (
      <div className="ox-col">
        <SessionEmpty icon={InformationCircleIcon} title={`${name}'s work didn't load`}>
          <p>{session?.reason ?? ""}</p>
          <button type="button" className="ui-btn ui-btn-sm" onClick={() => void controller?.reloadSession(id)}>Try again</button>
        </SessionEmpty>
      </div>
    );
  } else if (plane === "off" && load !== "failed") {
    body = (
      <div className="ox-col">
        <PlaneNote>
          {`${name} publishes no work events, so Work shows only what ${name} posted. Agents started with `}
          <code>cotal spawn</code> publish them unless started with <code>--no-events</code>.
        </PlaneNote>
        {list}
      </div>
    );
  } else if (steps.length === 0 && plane === "on") {
    body = (
      <div className="ox-col">
        <SessionEmpty icon={Wrench01Icon} title={`${name} hasn't started a turn yet`}>
          <p>Its first turn shows here as soon as it starts.</p>
        </SessionEmpty>
      </div>
    );
  } else if (steps.length === 0) {
    body = (
      <div className="ox-col">
        <SessionEmpty icon={InformationCircleIcon} title={`Nothing has arrived from ${name} yet`}>
          <p>Agents started with <code>cotal spawn</code> publish one unless started with <code>--no-events</code>. An agent you started yourself may not publish one at all.</p>
        </SessionEmpty>
      </div>
    );
  } else {
    body = (
      <div className="ox-col">
        {load === "failed" && (
          <PlaneNote>
            {`${name}'s work didn't load. ${session?.reason ?? ""} `}
            <button type="button" className="ui-btn ui-btn-sm" onClick={() => void controller?.reloadSession(id)}>Try again</button>
          </PlaneNote>
        )}
        {more && !atCap && (
          <div className="ui-cutoff">
            <button type="button" className="ui-btn ui-btn-sm" disabled={load === "loading"} onClick={() => void controller?.loadEarlier(id)}>Load earlier</button>
          </div>
        )}
        {more && atCap && <div className="ui-cutoff">Showing the newest 2,000 events</div>}
        {load === "loading" && <div className="ui-cutoff" role="status">Loading</div>}
        {list}
      </div>
    );
  }

  return (
    <>
      <header className="ox-head">
        {phone ? (
          <a className="ui-tool" href={formatRoute(back.route)} title={backTitle} aria-label={backTitle}>
            <Icon icon={ArrowLeft01Icon} className="ui-ic" />
          </a>
        ) : (
          <>
            <a className="ui-crumb" href={formatRoute(back.route)} title={backTitle}>
              <Icon icon={ArrowLeft01Icon} size={16} className="ui-ic" />
              {back.label}
            </a>
            <span className="ox-sep" />
          </>
        )}
        <Avatar vendor={known?.harness} status={row.status} size={30} badge={known ? badgeOf(id) : undefined} />
        <h1>{name}</h1>
        {!phone && sub && <span className="ui-topic">{sub}</span>}
        {known && <StatusBadge row={known} />}
        <span className="ui-sp" />
        {phone ? (
          <a className="ui-tool" href={messageHref} title={`Message ${name}`} aria-label={`Message ${name}`} onClick={focus}>
            <Icon icon={Message01Icon} className="ui-ic" />
          </a>
        ) : (
          <>
            <Button asChild variant="outline" size="sm" className="ox-btn">
              <a href={messageHref} onClick={focus}>
                <Icon icon={Message01Icon} size={16} />
                Message
              </a>
            </Button>
            {onTogglePanel && (
              <button type="button" className="ui-tool" title={panelLabel} aria-label={panelLabel} aria-pressed={panelOpen} onClick={onTogglePanel}>
                <Icon icon={SidebarRightIcon} className="ui-ic" />
              </button>
            )}
          </>
        )}
      </header>
      <Tabs value={tab} onValueChange={(next) => (next === "work" || next === "messages" || next === "profile") && goTo({ view: "agent", id, tab: next })} className="ox-tabs">
        <TabsList variant="line" aria-label={name} className="ox-tablist">
          <TabsTrigger value="work" className="ox-tab">Work</TabsTrigger>
          <TabsTrigger value="messages" className="ox-tab">Messages <span className="ox-n">{count}</span></TabsTrigger>
          <TabsTrigger value="profile" className="ox-tab">Profile</TabsTrigger>
        </TabsList>
        <TabsContent value="work" className="ox-tabc">
          <MessageScrollerProvider autoScroll={following}>
            <MessageScroller className="ox-scroller">
              <MessageScrollerViewport ref={viewport} aria-label="Work" className="ox-viewport" onScroll={onScroll}>
                <MessageScrollerContent className="ox-scrollc">{body}</MessageScrollerContent>
              </MessageScrollerViewport>
              <NewSteps steps={steps} away={!following} />
            </MessageScroller>
          </MessageScrollerProvider>
        </TabsContent>
        <TabsContent value="messages" className="ox-tabc">
          <div className="ui-scroll">
            <div className="ox-col"><AgentMessages groups={groups} row={row} nameOf={nameOf} /></div>
          </div>
        </TabsContent>
        <TabsContent value="profile" className="ox-tabc">
          <div className="ui-scroll">
            <div className="ox-col"><AgentProfile store={store} id={id} /></div>
          </div>
        </TabsContent>
      </Tabs>
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
