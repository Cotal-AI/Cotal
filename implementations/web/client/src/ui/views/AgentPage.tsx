import { ArrowDown02Icon, ArrowLeft01Icon, InformationCircleIcon, Message01Icon, SidebarRightIcon, SquareLock02Icon, Wrench01Icon } from "@hugeicons/core-free-icons";
import { useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../icons/Icon.tsx";
import { messageRoute, type ComposeTarget } from "../../lib/compose.js";
import { displayNameOf, nameIndex } from "../../lib/names.js";
import { rosterRows, type RosterRow } from "../../lib/roster.js";
import { formatRoute, type AgentTab, type Route } from "../../lib/route.js";
import { eventCount, foldWork, SESSION_EVENT_CAP, type SessionFrame, type Work, type WorkItem } from "../../lib/session.js";
import { SESSION_LIMIT_MAX, type Controller } from "../../state/controller.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { DashboardState, SessionState } from "../../state/types.js";
import { AgentMessages, messageGroups } from "../agent/AgentMessages.tsx";
import { AgentProfile } from "../agent/AgentProfile.tsx";
import { conditionOf, useOwnMessages, useSession } from "../agent/work.ts";
import { Avatar } from "../Avatar.tsx";
import { Composer, focusComposer } from "../Composer.tsx";
import { CopyCommand } from "../CopyCommand.tsx";
import { useBadgeOf } from "../identity.js";
import { harnessName } from "../MessageRow.tsx";
import { Navigate } from "../navigate.js";
import { PlaneNote } from "../session/PlaneNote.tsx";
import { SessionEmpty } from "../session/SessionEmpty.tsx";
import { SidebarToggle } from "../SidebarToggle.tsx";
import { Button } from "../shadcn/button.tsx";
import { Marker, MarkerContent } from "../shadcn/marker.tsx";
import { MessageScroller, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport, useMessageScroller, useMessageScrollerScrollable } from "../shadcn/message-scroller.tsx";
import { Skeleton } from "../shadcn/skeleton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../shadcn/tabs.tsx";
import { Toggle } from "../shadcn/toggle.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../shadcn/tooltip.tsx";
import { StatusWord } from "../Status.tsx";
import { WorkList } from "../work/WorkList.tsx";
import { reducedMotion } from "../../viewport.ts";

/** A reader within this many pixels of the bottom is following the work again. */
const PINNED_PX = 24;
/** Stable empty lists, so the fold is not redone while nothing is held. */
const NO_FRAMES: SessionFrame[] = [];

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

/** The skeleton rows of mock C, Loading. The bars are drawing, so assistive tech skips them. */
function WorkSkeleton() {
  const bar = (width: string) => <Skeleton className="h-2.5" style={{ width }} />;
  return (
    <div className="ox-col" aria-busy="true">
      <div className="flex flex-col gap-3" aria-hidden="true">
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
 *  since they left it, and a click back down through the scroller's `scrollToEnd`, at once under
 *  reduced motion. It draws only once one has. `away` says the page itself stopped following (an
 *  arrival at a message), which the scroller does not see as the reader's own scroll, so the button
 *  is drawn from either and is the page's own rather than the scroller's, whose state would hold it
 *  inert. */
function NewSteps({ steps, away }: { steps: readonly StepKey[]; away: boolean }) {
  const { end } = useMessageScrollerScrollable();
  const { scrollToEnd } = useMessageScroller();
  const [seen, setSeen] = useState<Set<string> | null>(null);
  const up = end || away;
  if (up && seen === null) setSeen(new Set(steps.map((s) => s.key)));
  if (!up && seen !== null) setSeen(null);
  const fresh = seen ? steps.filter((s) => s.live && !seen.has(s.key)).length : 0;
  if (fresh === 0) return null;
  return (
    <Button type="button" variant="outline" size="sm" className="ox-newsteps" data-active="true" onClick={() => scrollToEnd({ behavior: reducedMotion() ? "auto" : "smooth" })}>
      <Icon icon={ArrowDown02Icon} data-icon="inline-start" />
      {fresh === 1 ? "1 new step" : `${fresh} new steps`}
    </Button>
  );
}

/** One agent as a place (overhaul mock B1, C, D and E): `#/agent/<id>` with Work, Messages and
 *  Profile tabs.
 *
 *  - The header: the SidebarToggle, the crumb back to `back` with its label, the avatar with its
 *    badge, the name, role and harness, the status Badge (the working icon turns), Message to the
 *    operator's conversation with the agent with its composer focused, and the panel button. On a
 *    phone the crumb is the back button, the role and harness are left out and Message is an icon.
 *  - The tabs are the route: choosing a tab writes `#/agent/<id>/<tab>` through `Navigate`, so back
 *    and reload keep it. Arrow keys only move focus (manual activation), so they add no history.
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
  const navigate = useContext(Navigate);
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
  const list = <WorkList payloadRead={session?.payloadRead} work={work} row={row} condition={condition} highlight={at} nameOf={nameOf} />;

  let body;
  if (load === "loading" && steps.length === 0) {
    body = <WorkSkeleton />;
  } else if (load === "refused") {
    body = (
      <div className="ox-col">
        <SessionEmpty icon={SquareLock02Icon} title={`This dashboard can't read ${name}'s work`} action={session?.grant && <CopyCommand command={session.grant} />}>
          <p>{`The broker refused it: ${session?.reason ?? ""}.`}</p>
          {session?.grant && <p>The mesh owner can grant a read on that channel:</p>}
        </SessionEmpty>
        {steps.length > 0 && list}
      </div>
    );
  } else if (load === "failed" && steps.length === 0) {
    body = (
      <div className="ox-col">
        <SessionEmpty icon={InformationCircleIcon} title={`${name}'s work didn't load`} action={<Button type="button" variant="outline" size="sm" onClick={() => void controller?.reloadSession(id)}>Try again</Button>}>
          <p>{session?.reason ?? ""}</p>
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
          <PlaneNote action={<Button type="button" variant="outline" size="sm" onClick={() => void controller?.reloadSession(id)}>Try again</Button>}>
            {`${name}'s work didn't load. ${session?.reason ?? ""}`}
          </PlaneNote>
        )}
        {more && !atCap && (
          <Marker variant="separator" className="mb-3">
            <Button type="button" variant="outline" size="sm" disabled={load === "loading"} onClick={() => void controller?.loadEarlier(id)}>Load earlier</Button>
          </Marker>
        )}
        {more && atCap && (
          <Marker className="mb-3">
            <MarkerContent>Showing the newest 2,000 events</MarkerContent>
          </Marker>
        )}
        {load === "loading" && (
          <Marker className="mb-3" role="status">
            <MarkerContent>Loading</MarkerContent>
          </Marker>
        )}
        {list}
      </div>
    );
  }

  return (
    <>
      <header className="ox-head">
        <SidebarToggle />
        {phone ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="ghost" size="icon">
                <a href={formatRoute(back.route)} aria-label={backTitle}>
                  <Icon icon={ArrowLeft01Icon} />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{backTitle}</TooltipContent>
          </Tooltip>
        ) : (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <a className="ui-crumb" href={formatRoute(back.route)} aria-label={backTitle}>
                  <Icon icon={ArrowLeft01Icon} size={16} className="ui-ic" />
                  {back.label}
                </a>
              </TooltipTrigger>
              <TooltipContent>{backTitle}</TooltipContent>
            </Tooltip>
            <span className="ox-sep" />
          </>
        )}
        <Avatar vendor={known?.harness} status={row.status} size={30} badge={known ? badgeOf(id) : undefined} />
        <h1>{name}</h1>
        {!phone && sub && <span className="ui-topic">{sub}</span>}
        {known && <StatusWord row={known} />}
        <span className="ui-sp" />
        {phone ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="ghost" size="icon">
                <a href={messageHref} aria-label={`Message ${name}`} onClick={focus}>
                  <Icon icon={Message01Icon} />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{`Message ${name}`}</TooltipContent>
          </Tooltip>
        ) : (
          <>
            <Button asChild variant="outline" size="sm">
              <a href={messageHref} onClick={focus}>
                <Icon icon={Message01Icon} data-icon="inline-start" />
                Message
              </a>
            </Button>
            {onTogglePanel && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Toggle aria-label={panelLabel} pressed={panelOpen} onPressedChange={onTogglePanel}>
                    <Icon icon={SidebarRightIcon} />
                  </Toggle>
                </TooltipTrigger>
                <TooltipContent>{panelLabel}</TooltipContent>
              </Tooltip>
            )}
          </>
        )}
      </header>
      <Tabs value={tab} activationMode="manual" onValueChange={(next) => (next === "work" || next === "messages" || next === "profile") && navigate({ view: "agent", id, tab: next })} className="ox-tabs">
        <div className="ox-tablist">
          <TabsList aria-label={name}>
            <TabsTrigger value="work">Work</TabsTrigger>
            <TabsTrigger value="messages">Messages <span className="ox-n">{count}</span></TabsTrigger>
            <TabsTrigger value="profile">Profile</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="work" className="ox-tabc">
          <MessageScrollerProvider autoScroll={following}>
            <MessageScroller className="ox-scroller">
              <MessageScrollerViewport ref={viewport} aria-label="Work" onScroll={onScroll}>
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
