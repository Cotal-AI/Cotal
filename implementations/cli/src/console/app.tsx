import { writeSync } from "node:fs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useFocusManager, useInput, useStdout } from "ink";
import type { CotalEndpoint, Presence } from "@cotal-ai/core";
import { useMesh } from "./mesh.js";
import { control, controlPs, deleteChannel, type ControlCtx, type ControlOp } from "./control.js";
import { attachSeat } from "../commands/agents.js";
import { detachKey } from "../lib/attach-client.js";
import { Tabs } from "./ui/Tabs.js";
import { Tiles } from "./ui/Tiles.js";
import { Roster, harnessTag } from "./ui/Roster.js";
import { Feed } from "./ui/Feed.js";
import { NeedsYou } from "./ui/NeedsYou.js";
import { Dm } from "./ui/Dm.js";
import { Topo, type TopoVariant } from "./ui/topo/Topo.js";
import { StatusBar } from "./ui/StatusBar.js";
import { Help } from "./ui/Help.js";
import { Search } from "./ui/Search.js";
import { CommandPalette } from "./ui/CommandPalette.js";
import { Confirm, type ConfirmTarget } from "./ui/Confirm.js";
import { Prompt } from "./ui/Prompt.js";
import { Detail, type DetailTarget } from "./ui/Detail.js";
import { runCommand, type CommandCtx } from "./commands.js";
import { mentionsIn } from "../lib/mentions.js";
import type { FeedEntry, FocusId } from "./mesh.js";

/** An in-progress compose: post to a channel, DM a peer, or reply to a feed message. */
type ComposeTarget =
  | { kind: "channel"; channel: string; value: string }
  | { kind: "dm"; toId: string; toName: string; value: string }
  | { kind: "reply"; entry: FeedEntry; value: string };

/** How often the console re-reads the manager's managed rows (which harness runs each seat). Each
 *  poll is a full per-action control call (resolve, mint, connect, describe, invoke), so it is
 *  deliberately slow. */
const PS_POLL_MS = 10_000;

/**
 * The lazygit-style console: channel tabs · golden-signal tiles · roster · live feed · status bar,
 * plus the NEEDS-YOU rail (`n`), the DM lens (`d`), and the `:` operator command palette. `useMesh`
 * owns the observer endpoint; panels lay out `mesh` and (when `canWrite`) the palette publishes
 * chat over the same endpoint. Control (`D` kill, `:spawn` / `:purge` / `:status` / `:ps`)
 * never rides the observer: each action is one call through the CLI's
 * per-action control path (console/control.ts), gated on `canControl`. Input is single-source:
 * this global handler owns the keys/overlays; panels' keys are gated on focus and `blocked`.
 */
export function App({
  ep,
  tapSubject,
  onBack,
  canWrite,
  canControl,
  controlCtx,
  makeParticipant,
}: {
  ep: CotalEndpoint;
  tapSubject?: string;
  onBack?: () => void;
  canWrite?: boolean;
  canControl?: boolean;
  /** The `--server` / `--creds` half of the control coordinates; the App adds the watched space. */
  controlCtx?: Omit<ControlCtx, "space">;
  /** Builds the operator's presence peer (root.tsx); absent where the mesh cannot host one. */
  makeParticipant?: () => CotalEndpoint;
}) {
  const mesh = useMesh(ep, { tapSubject });
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { focus, focusNext, focusPrevious } = useFocusManager();

  const [size, setSize] = useState({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  const [activeChannel, setActiveChannel] = useState("all");
  const [helpOpen, setHelpOpen] = useState(false);
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [search, setSearch] = useState({ active: false, query: "" });
  const [focusedId, setFocusedId] = useState<FocusId>("feed");
  const [mode, setMode] = useState<"normal" | "dm" | "topo">("normal");
  const [topoVariant, setTopoVariant] = useState<TopoVariant>(0);
  const [railOpen, setRailOpen] = useState(false);
  const [palette, setPalette] = useState({ active: false, query: "" });
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
  const [compose, setCompose] = useState<ComposeTarget | null>(null);
  const [notice, setNotice] = useState<string | undefined>();
  const [attachTarget, setAttachTarget] = useState<{ name: string } | null>(null);

  const overlay = helpOpen || detail !== null;
  const blocked = overlay || search.active || palette.active || confirm !== null || compose !== null;

  // ---- geometry (pure from size / mode / rail / search / palette / compose) ---
  const narrow = size.cols < 80;
  const composeRow = compose ? 1 : 0;
  // The filter row hides while the palette or a compose prompt owns the bottom region.
  const searchRow = (search.active || search.query) && !palette.active && !compose ? 1 : 0;
  const tilesRow = 1;
  const paletteRows = palette.active ? 7 : 0; // CommandPalette is a fixed 6 suggestions + 1 input
  const noticeRow = notice ? 1 : 0;
  const bodyH = Math.max(
    3,
    size.rows - 3 /* tabs */ - tilesRow - 1 /* status */ - searchRow - paletteRows - noticeRow - composeRow,
  );
  // The needs-you rail is a side column only on a genuinely wide terminal; otherwise `n` opens it
  // full-screen so it never squeezes the feed unreadably. It never coexists with the DM/topo lens.
  const railAsColumn = railOpen && !narrow && size.cols >= 100 && mode === "normal";
  const railOverlay = railOpen && mode === "normal" && !railAsColumn;
  const railW = railAsColumn ? Math.min(34, Math.max(24, Math.floor(size.cols * 0.28))) : 0;
  const bodyW = size.cols - railW;
  let roster: { w: number; h: number };
  let feed: { w: number; h: number };
  if (narrow) {
    const rH = Math.min(8, Math.max(3, Math.floor(bodyH * 0.35)));
    roster = { w: bodyW, h: rH };
    feed = { w: bodyW, h: bodyH - rH };
  } else {
    const rW = Math.min(36, Math.max(24, Math.floor(bodyW * 0.3)));
    roster = { w: rW, h: bodyH };
    feed = { w: bodyW - rW, h: bodyH };
  }
  const normalFocus: FocusId =
    focusedId === "roster" ? "roster" : focusedId === "needsyou" && railAsColumn ? "needsyou" : "feed";

  // Focus the right pane after an overlay closes, or when switching into/out of a view.
  useEffect(() => {
    if (overlay || confirm || attachTarget) return;
    if (railOverlay) focus("needsyou");
    else if (mode === "dm") focus("dmpeers");
    else if (mode === "topo") focus("topo");
    else focus(normalFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [helpOpen, detail, mode, railOpen, confirm]);

  // One control call against the manager of THIS space (console/control.ts): resolve, mint a
  // one-shot instrument, call, drop. The observer endpoint is never involved.
  const ctl = useCallback(
    (op: ControlOp, args?: Record<string, unknown>) => control({ ...controlCtx, space: ep.space }, op, args),
    [ep.space, controlCtx],
  );

  // Managed state lives in the manager, not in presence: only the manager knows WHICH harness it
  // launched (`agent` = connector, `mode` = runtime) for a seat whose card carries no meta. Poll
  // the manager's rows at a low rate and merge by the non-forgeable id; fail QUIET and stop
  // polling when nothing answers (an open mesh without a supervisor must not spin or flash errors
  // on every tick).
  const [managed, setManaged] = useState<Map<string, { agent?: string; mode?: string }>>(new Map());
  const psDead = useRef(false);
  useEffect(() => {
    if (!canControl || !controlCtx) return;
    psDead.current = false;
    let alive = true;
    const poll = async () => {
      if (!alive || psDead.current) return;
      const r = await controlPs({ ...controlCtx, space: ep.space });
      if (!alive) return;
      if (!r.ok) {
        psDead.current = true; // no manager on this mesh: stop knocking
        return;
      }
      setManaged((prev) => {
        const next = new Map(r.rows.map((a) => [a.id, { agent: a.agent, mode: a.mode }]));
        const same =
          next.size === prev.size &&
          [...next].every(([id, m]) => {
            const p = prev.get(id);
            return p !== undefined && p.agent === m.agent && p.mode === m.mode;
          });
        return same ? prev : next;
      });
    };
    void poll();
    const t = setInterval(() => void poll(), PS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [canControl, controlCtx, ep.space]);

  // Keep last-seen ages fresh.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Auto-clear the transient action notice.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(undefined), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  // Suspend the console and hand the terminal to the seat. The `attachTarget` render commits
  // App→null and gates the top-level useInput, so Ink releases stdin (ref-counted raw mode) BEFORE
  // the attach loop takes it. The loop is the CLI's own (`attachSeat`): seat locality, the
  // one-use holder-bound session over the mesh, reconnect with backoff, end-reason classification,
  // the abandoned-session hand-back, and the terminal given back before the verdict returns. The
  // observer endpoint + MeshView keep running in the background (App stays mounted). On return,
  // re-assert the console's alt-screen / alt-scroll / cursor (the loop leaves us in the main
  // buffer after a full-screen child) and show the verdict.
  useEffect(() => {
    if (!attachTarget) return;
    let cancelled = false;
    const { name } = attachTarget;
    void (async () => {
      let verdict: Awaited<ReturnType<typeof attachSeat>>;
      try {
        verdict = await attachSeat({ ...controlCtx, space: ep.space, name }, { reconnect: true, onRefusal: "throw" });
      } catch (e) {
        verdict = { kind: "failed", message: (e as Error).message };
      }
      try {
        writeSync(process.stdout.fd, "\x1b[?1049h\x1b[?1007h\x1b[?25h");
      } catch {
        /* stdout gone */
      }
      if (cancelled) return;
      setAttachTarget(null);
      setNotice(verdict.kind === "ended" ? `detached from ${name}` : verdict.kind === "gone" ? `seat ${name} is gone` : `attach: ${verdict.message}`);
    })();
    return () => {
      cancelled = true;
    };
  }, [attachTarget, controlCtx, ep.space]);

  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const tabs = ["all", ...mesh.channels.map((ch) => ch.channel)];
  const counts: Record<string, number> = {};
  for (const ch of mesh.channels) counts[ch.channel] = ch.messages;

  // Per-channel unread: pure client state over MeshView's live ARRIVAL counters (the web
  // sidebar's badges are the same kind of state). The broker's retained count is not the base: it
  // is capped per sender, so it stops climbing under live traffic and a badge built on it goes
  // quiet at the cap. Arrivals start at zero for every channel when the console starts, so history
  // is not unread and no baseline snapshot is needed: a channel with no watermark, including one
  // that first appears on a mesh that was empty at start, has every arrival unread. Viewing a
  // concrete channel keeps its watermark pinned to the arrivals so far (viewing clears).
  const [seen, setSeen] = useState<Record<string, number>>({});
  useEffect(() => {
    setSeen((s) => {
      let next = s;
      const bump = (channel: string, v: number) => {
        if (next === s) next = { ...s };
        next[channel] = v;
      };
      // A channel that left the strip (deleted) drops its watermark once it is gone, not before:
      // dropping it while the tab is still listed would badge everything seen so far as unread.
      // MeshView drops its arrivals with the channel, so a channel created again later is new, and
      // every arrival on it is unread, like any channel that appears after the baseline.
      const listed = new Set(mesh.channels.map((ch) => ch.channel));
      for (const channel of Object.keys(next))
        if (!listed.has(channel)) {
          if (next === s) next = { ...s };
          delete next[channel];
        }
      const cur = mesh.channels.find((ch) => ch.channel === activeChannel)?.arrivals;
      if (activeChannel !== "all" && cur !== undefined && next[activeChannel] !== cur) bump(activeChannel, cur);
      return next;
    });
    // an activeChannel change must also re-pin the watermark.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesh.channels, activeChannel]);
  const unread: Record<string, number> = {};
  for (const ch of mesh.channels) {
    const n = ch.arrivals - (seen[ch.channel] ?? 0);
    if (n > 0 && ch.channel !== activeChannel) unread[ch.channel] = n;
  }

  // id → short harness tag for the roster (what the agent IS): the card's self-published
  // meta.connector first, the manager's launch record for a seat whose card carries no meta.
  const harness = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of mesh.agents) {
      const meta = p.card.meta as Record<string, unknown> | undefined;
      const connector = typeof meta?.connector === "string" ? meta.connector : managed.get(p.card.id)?.agent;
      const tag = harnessTag(connector);
      if (tag) m.set(p.card.id, tag);
    }
    return m;
  }, [mesh.agents, managed]);

  const onFocus = useCallback((id: FocusId) => setFocusedId(id), []);
  const openAgent = useCallback((p: Presence) => setDetail({ kind: "agent", agent: p }), []);
  const openMessage = useCallback((e: FeedEntry) => setDetail({ kind: "message", entry: e }), []);
  const handleKill = useCallback((p: Presence) => setConfirm({ kind: "kill", name: p.card.name }), []);
  // Attach: open the seat's live terminal. Keyed by NAME (a managed seat need not be a roster peer,
  // same as `cotal attach --name`). A bad COTAL_DETACH_KEY is refused BEFORE suspending, as a
  // notice: the loop would only throw it after the takeover, with the screen already gone.
  const handleAttach = useCallback(
    (name: string) => {
      if (!canControl) return setNotice("no control path - a raw --creds file cannot drive the manager; run against a registered mesh");
      try {
        detachKey();
      } catch (e) {
        return setNotice("attach: " + (e as Error).message);
      }
      setNotice(`attaching to ${name}…`);
      setAttachTarget({ name });
    },
    [canControl],
  );
  const feedCompose = useCallback(
    () => setCompose({ kind: "channel", channel: activeChannel === "all" ? "general" : activeChannel, value: "" }),
    [activeChannel],
  );
  const feedReply = useCallback((e: FeedEntry) => setCompose({ kind: "reply", entry: e, value: "" }), []);
  const rosterCompose = useCallback(
    (p: Presence) => setCompose({ kind: "dm", toId: p.card.id, toName: p.card.name, value: "" }),
    [],
  );

  const composeLabel = (c: ComposeTarget): string =>
    c.kind === "channel"
      ? "→ #" + c.channel
      : c.kind === "dm"
        ? "→ @" + c.toName
        : "↩ " + c.entry.from.name + (c.entry.delivery === "multicast" && c.entry.channel ? " #" + c.entry.channel : "");

  // First time the operator sends anything, put the operator on the roster: start the presence
  // peer (root.tsx's makeParticipant, the observer's own card), so agents see the operator and
  // their DM replies have a peer to land on; the whole-space tap the open-mesh console already
  // runs is what shows them in the DM lens. Idempotent, canWrite-gated (a pure-watch session never
  // calls it). A refused start leaves the operator invisible and is shown; the next send retries.
  //
  // OPEN MESH ONLY, and said so rather than degraded: Root offers no peer under auth, where the
  // tap is narrowed to chat and an agent-grade credential holds no live read of its own DM inbox
  // (DMs ride its lifecycle-keyed durable, which the observer does not consume), so a reply could
  // never be shown here. A send there is one-way, and the status line says exactly that once.
  const participant = useRef<CotalEndpoint | null>(null);
  const activatedRef = useRef(false);
  const [onRoster, setOnRoster] = useState(false); // the status bar says so for the rest of the session
  const ensureParticipant = useCallback(async () => {
    if (activatedRef.current || !canWrite) return;
    activatedRef.current = true;
    if (!makeParticipant) return setNotice("sent one-way: under this credential replies cannot land in the console");
    const peer = makeParticipant();
    try {
      await peer.start();
      participant.current = peer;
      setOnRoster(true);
    } catch (e) {
      activatedRef.current = false; // let the next send retry
      setNotice("participant: " + (e as Error).message);
    }
  }, [canWrite, makeParticipant]);
  // The peer leaves with the console (an offline record, like the observer's own stop in useMesh).
  useEffect(
    () => () => {
      void participant.current?.stop();
      participant.current = null;
    },
    [],
  );

  // Send the in-progress compose over the live endpoint.
  const submitCompose = () => {
    const c = compose;
    if (!c) return;
    setCompose(null);
    const text = c.value.trim();
    if (!text) return;
    const ok = (label: string) => () => setNotice(label);
    const fail = (e: unknown) => setNotice("send: " + (e as Error).message);
    void ensureParticipant().then(() => {
      if (c.kind === "channel")
        void ep.multicast(text, { channel: c.channel, mentions: mentionsIn(text) }).then(ok("→ #" + c.channel)).catch(fail);
      else if (c.kind === "dm") void ep.unicast(c.toId, text).then(ok("→ " + c.toName)).catch(fail);
      else {
        const e = c.entry;
        const send =
          e.delivery === "multicast" && e.channel
            ? ep.multicast(text, { channel: e.channel, replyTo: e.id, mentions: mentionsIn(text) })
            : ep.unicast(e.from.id, text, { replyTo: e.id });
        void send.then(ok("↩ " + e.from.name)).catch(fail);
      }
    });
  };

  // Run a typed palette line against the live endpoint.
  const runPaletteLine = (line: string) => {
    setPalette({ active: false, query: "" });
    const ctx: CommandCtx = {
      ep,
      snapshot: mesh,
      activeChannel,
      setMode,
      setActiveChannel,
      toggleRail: () => setRailOpen((v) => !v),
      openHelp: () => setHelpOpen(true),
      back: onBack,
      exit,
      notify: setNotice,
      control: ctl,
      ps: () => controlPs({ ...controlCtx, space: ep.space }),
      confirmPurge: () => setConfirm({ kind: "purge", space: ep.space }),
      confirmDelchan: (channel: string) => setConfirm({ kind: "delchan", channel }),
      startAttach: handleAttach,
      ensureParticipant,
    };
    runCommand(line, ctx, !!canWrite, !!canControl);
  };

  // Confirmed destructive action (kill / purge; space-delete is handled in the picker). Both go
  // through the control door: `stop` is the CLI's own `cotal stop` (seat locality, then the
  // targeted despawn with any-mode reach on a static or open mesh, owner reach on a user mesh);
  // `purge` is the manager.admin op behind the typed-name confirm.
  const onConfirmed = (opts?: { force?: boolean }) => {
    const c = confirm;
    setConfirm(null);
    if (c?.kind === "kill") {
      const graceful = !opts?.force;
      setNotice(`${graceful ? "stopping" : "force-killing"} ${c.name}…`);
      void ctl("stop", { name: c.name, graceful }).then((r) =>
        setNotice(r.ok ? `${graceful ? "stopped" : "force-killed"} ${c.name}` : `stop: ${r.error ?? "failed"}`),
      );
    } else if (c?.kind === "purge") {
      setNotice(`purging ${c.space}…`);
      void ctl("purge", {}).then((r) => setNotice(r.ok ? "purged space history" : `purge: ${r.error ?? "failed"}`));
    } else if (c?.kind === "delchan") {
      // Core's clearChannel with the web's per-action authority (console/control.ts). The tab
      // vanishes on the next channel poll (MeshView rebuilds the list from the broker) and its
      // unread bookkeeping goes with it; leave it now if it is the one being viewed.
      setNotice(`deleting #${c.channel}…`);
      void deleteChannel({ ...controlCtx, space: ep.space }, c.channel).then((r) => {
        if (!r.ok) return setNotice(`delchan: ${r.error}`);
        setNotice(`deleted #${c.channel} · ${r.purged} messages purged`);
        setActiveChannel((ch) => (ch === c.channel ? "all" : ch));
      });
    }
  };

  useInput(
    (input, key) => {
      if (helpOpen) return setHelpOpen(false);
      if (detail) return setDetail(null);
      if (search.active) return; // the Search line owns input while open
      if (input === "?") return setHelpOpen(true);
      if (input === "/") return setSearch((s) => ({ active: true, query: s.query }));
      if (input === ":") return setPalette({ active: true, query: "" });
      if (key.escape) {
        // lazygit-style "back": pop one level per press, then return to the space overview.
        if (mode === "dm" || mode === "topo") return setMode("normal");
        if (railOverlay) return setRailOpen(false);
        if (search.query) return setSearch({ active: false, query: "" });
        if (onBack) return onBack();
        return;
      }
      if (input === "q") return exit();
      if (onBack && input === "b" && mode === "normal") return onBack(); // quick back to the overview
      if (input === "d" && !key.ctrl) return setMode((m) => (m === "dm" ? "normal" : "dm")); // Ctrl-d = scroll
      if (input === "t") return setMode((m) => (m === "topo" ? "normal" : "topo"));
      if (input === "v" && mode === "topo") return setTopoVariant((v) => ((v + 1) % 3) as TopoVariant);
      if (mode === "topo" && input >= "1" && input <= "3")
        return setTopoVariant((Number(input) - 1) as TopoVariant);
      if (input === "n") return setRailOpen((v) => !v);
      if (key.leftArrow || input === "h") return focusPrevious();
      if (key.rightArrow || input === "l") return focusNext();
      if (input === "[" || input === "]") {
        const cur = Math.max(0, tabs.indexOf(activeChannel));
        const next = input === "]" ? Math.min(tabs.length - 1, cur + 1) : Math.max(0, cur - 1);
        return setActiveChannel(tabs[next]);
      }
      if (input >= "1" && input <= "9") {
        const idx = Number(input) - 1;
        if (idx < tabs.length) setActiveChannel(tabs[idx]);
      }
    },
    { isActive: !attachTarget && !palette.active && confirm === null && compose === null },
  );

  // Attached: render nothing so Ink releases stdin/stdout to the seat (the suspend effect owns the
  // terminal). App stays mounted, so the observer endpoint + MeshView survive in the background.
  if (attachTarget) return null;
  if (helpOpen) return <Help focusedId={focusedId} width={size.cols} height={size.rows} />;
  if (detail) return <Detail target={detail} feed={mesh.feed} width={size.cols} height={size.rows} managed={managed} />;
  if (confirm)
    return (
      <Confirm target={confirm} width={size.cols} height={size.rows} onConfirm={onConfirmed} onCancel={() => setConfirm(null)} />
    );
  if (railOverlay)
    return (
      <NeedsYou
        waiting={mesh.signals.waiting}
        boxWidth={size.cols}
        boxHeight={size.rows}
        blocked={blocked}
        onFocus={onFocus}
        onOpenDetail={openAgent}
      />
    );

  return (
    <Box flexDirection="column" width={size.cols} height={size.rows}>
      <Tabs tabs={tabs} active={activeChannel} counts={counts} unread={unread} width={size.cols} />
      <Tiles counts={mesh.signals.counts} stalestLiveTs={mesh.signals.stalestLiveTs} width={size.cols} />
      {mode === "dm" ? (
        <Dm
          dms={mesh.signals.dms}
          dmVisible={mesh.status.dmVisible}
          width={size.cols}
          height={bodyH}
          narrow={narrow}
          blocked={blocked}
          onFocus={onFocus}
        />
      ) : mode === "topo" ? (
        <Topo
          feed={mesh.feed}
          agents={mesh.agents}
          membership={mesh.membership}
          channels={mesh.channels}
          nameOf={mesh.nameOf}
          variant={topoVariant}
          width={size.cols}
          height={bodyH}
          blocked={blocked}
          onFocus={onFocus}
          onOpenAgent={openAgent}
          onOpenMessage={openMessage}
        />
      ) : (
        <Box flexDirection={narrow ? "column" : "row"} height={bodyH}>
          <Box flexDirection={narrow ? "column" : "row"} width={bodyW} height={bodyH}>
            <Roster
              agents={mesh.agents}
              endpoints={mesh.endpoints}
              query={search.query}
              boxWidth={roster.w}
              boxHeight={roster.h}
              wide={!narrow}
              blocked={blocked}
              onFocus={onFocus}
              onOpenDetail={openAgent}
              onKill={canControl ? handleKill : undefined}
              onAttach={canControl ? (p) => handleAttach(p.card.name) : undefined}
              harness={harness}
              onCompose={canWrite ? rosterCompose : undefined}
            />
            <Feed
              entries={mesh.feed}
              activeChannel={activeChannel}
              query={search.query}
              boxWidth={feed.w}
              boxHeight={feed.h}
              blocked={blocked}
              onFocus={onFocus}
              onOpenDetail={openMessage}
              onCompose={canWrite ? feedCompose : undefined}
              onReply={canWrite ? feedReply : undefined}
            />
          </Box>
          {railAsColumn ? (
            <NeedsYou
              waiting={mesh.signals.waiting}
              boxWidth={railW}
              boxHeight={bodyH}
              blocked={blocked}
              onFocus={onFocus}
              onOpenDetail={openAgent}
            />
          ) : null}
        </Box>
      )}
      {notice ? (
        <Box width={size.cols} paddingX={1}>
          <Text color="cyan" wrap="truncate-end">
            {notice}
          </Text>
        </Box>
      ) : null}
      {compose ? (
        <Prompt
          label={composeLabel(compose)}
          value={compose.value}
          width={size.cols}
          onChange={(v) => setCompose((c) => (c ? { ...c, value: v } : c))}
          onSubmit={submitCompose}
          onCancel={() => setCompose(null)}
        />
      ) : palette.active ? (
        <CommandPalette
          active={palette.active}
          query={palette.query}
          snapshot={mesh}
          canWrite={!!canWrite}
          canControl={!!canControl}
          width={size.cols}
          onChange={(q) => setPalette((p) => ({ ...p, query: q }))}
          onRun={runPaletteLine}
          onCancel={() => setPalette({ active: false, query: "" })}
        />
      ) : searchRow ? (
        <Search
          query={search.query}
          active={search.active}
          width={size.cols}
          onChange={(q) => setSearch((s) => ({ ...s, query: q }))}
          onSubmit={() => setSearch((s) => ({ ...s, active: false }))}
          onCancel={() => setSearch({ active: false, query: "" })}
        />
      ) : null}
      <StatusBar
        status={mesh.status}
        rates={mesh.rates}
        activeChannel={activeChannel}
        agentCount={mesh.agents.length}
        mode={mode}
        railOpen={railOpen}
        canBack={!!onBack}
        canWrite={!!canWrite}
        canControl={!!canControl}
        onRoster={onRoster}
        width={size.cols}
      />
    </Box>
  );
}
