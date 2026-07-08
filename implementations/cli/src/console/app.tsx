import { writeSync } from "node:fs";
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useFocusManager, useInput, useStdout } from "ink";
import {
  CONTROL_ADMIN,
  CONTROL_PRIVILEGED,
  type ControlTier,
  type CotalEndpoint,
  type Presence,
} from "@cotal-ai/core";
import { useMesh } from "./mesh.js";
import { control, type ControlCtx } from "./control.js";
import { attachClient, detachKey } from "../lib/attach-client.js";
import { Tabs } from "./ui/Tabs.js";
import { Roster } from "./ui/Roster.js";
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
import { Views } from "./ui/Views.js";
import { SpecView } from "./render/SpecView.js";
import { tilesSpec } from "./render/spec.js";
import { runCommand, type CommandCtx } from "./commands.js";
import { mentionsIn } from "../lib/mentions.js";
import type { FeedEntry, FocusId } from "./mesh.js";

/** An in-progress compose: post to a channel, DM a peer, or reply to a feed message. */
type ComposeTarget =
  | { kind: "channel"; channel: string; value: string }
  | { kind: "dm"; toId: string; toName: string; value: string }
  | { kind: "reply"; entry: FeedEntry; value: string };

/**
 * The lazygit-style console: channel tabs · golden-signal tiles · roster · live feed · status bar,
 * plus the NEEDS-YOU rail (`n`), the DM lens (`d`), the `:` operator command palette, and `D` to
 * kill a selected agent. `useMesh` owns the observer endpoint; panels lay out `mesh` and (when
 * `canWrite`) the palette/`D` publish + control over the same endpoint. Input is single-source:
 * this global handler owns the keys/overlays; panels' keys are gated on focus and `blocked`.
 */
export function App({
  ep,
  tapSubject,
  onBack,
  canWrite,
  canControl,
  controlCtx,
}: {
  ep: CotalEndpoint;
  tapSubject?: string;
  onBack?: () => void;
  canWrite?: boolean;
  canControl?: boolean;
  controlCtx?: Omit<ControlCtx, "space">;
}) {
  const { state: mesh, activateParticipant, recordOutboundDm } = useMesh(ep, { tapSubject });
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { focus, focusNext, focusPrevious } = useFocusManager();

  const [size, setSize] = useState({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  const [activeChannel, setActiveChannel] = useState("all");
  const [helpOpen, setHelpOpen] = useState(false);
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [search, setSearch] = useState({ active: false, query: "" });
  const [focusedId, setFocusedId] = useState<FocusId>("feed");
  const [mode, setMode] = useState<"normal" | "dm" | "topo" | "views">("normal");
  const [topoVariant, setTopoVariant] = useState<TopoVariant>(0);
  const [railOpen, setRailOpen] = useState(false);
  const [palette, setPalette] = useState({ active: false, query: "" });
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
  const [compose, setCompose] = useState<ComposeTarget | null>(null);
  const [notice, setNotice] = useState<string | undefined>();
  const [attachTarget, setAttachTarget] = useState<{ name: string; ws: string } | null>(null);

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
    else if (mode === "views") return; // the view lens has no focusable child
    else focus(normalFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [helpOpen, detail, mode, railOpen, confirm]);

  // Keep last-seen ages fresh.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Per-action control against the manager for THIS space (see console/control.ts — the observer
  // endpoint never carries control; each action makes its own tier-scoped request).
  const ctl = useCallback(
    (op: string, args: Record<string, unknown>, tier: ControlTier) =>
      control({ space: ep.space, server: controlCtx?.server ?? "", auth: controlCtx?.auth, creds: controlCtx?.creds }, op, args, tier),
    [ep.space, controlCtx],
  );

  // Paused-ness lives in the manager's managed-state, NOT presence — a SIGSTOPped agent's
  // heartbeat freezes, so its presence key TTLs out to "offline" and would lie. Poll `ps` at a
  // low rate and merge by non-forgeable id; fail QUIET and stop polling when no manager answers
  // (an open mesh without a supervisor must not spin or flash errors).
  const [pausedIds, setPausedIds] = useState<Set<string>>(new Set());
  const psDead = useRef(false);
  useEffect(() => {
    if (!canControl || !controlCtx) return;
    psDead.current = false;
    let alive = true;
    const poll = async () => {
      if (!alive || psDead.current) return;
      const r = await ctl("ps", {}, CONTROL_PRIVILEGED).catch(() => ({ ok: false as const, error: "" }));
      if (!alive) return;
      if (!r.ok) {
        psDead.current = true; // no manager on this mesh — don't keep knocking
        return;
      }
      const list = (r.data ?? []) as { id: string; paused?: boolean }[];
      setPausedIds((prev) => {
        const next = new Set(list.filter((a) => a.paused).map((a) => a.id));
        if (next.size === prev.size && [...next].every((id) => prev.has(id))) return prev;
        return next;
      });
    };
    void poll();
    const t = setInterval(() => void poll(), 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [canControl, controlCtx, ctl]);

  // Auto-clear the transient action notice.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(undefined), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  // Suspend the console and hand the terminal to the agent's PTY. The `attachTarget` render commits
  // App→null + gates the top-level useInput, so Ink releases stdin (ref-counted raw mode) BEFORE
  // attachClient grabs it. The observer endpoint + MeshView keep running in the background (App
  // stays mounted). On detach (Ctrl-]) or ws close, re-assert the console's alt-screen/alt-scroll/
  // cursor — attachClient leaves us in the main buffer after a full-screen child — then resume.
  useEffect(() => {
    if (!attachTarget) return;
    let cancelled = false;
    void (async () => {
      let failed = false;
      try {
        await attachClient(attachTarget.ws);
      } catch (e) {
        failed = true;
        if (!cancelled) setNotice("attach: " + (e as Error).message);
      } finally {
        try {
          writeSync(process.stdout.fd, "\x1b[?1049h\x1b[?1007h\x1b[?25h");
        } catch {
          /* stdout gone */
        }
        if (!cancelled) {
          setAttachTarget(null);
          // On failure the catch's error notice must survive the resume — don't overwrite it.
          if (!failed) setNotice(`detached from ${attachTarget.name}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachTarget]);

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

  const onFocus = useCallback((id: FocusId) => setFocusedId(id), []);
  const openAgent = useCallback((p: Presence) => setDetail({ kind: "agent", agent: p }), []);
  const openMessage = useCallback((e: FeedEntry) => setDetail({ kind: "message", entry: e }), []);
  const handleKill = useCallback((p: Presence) => setConfirm({ kind: "kill", name: p.card.name }), []);
  // Pause/resume toggle — recoverable, so no confirm (graduated destructiveness). Admin tier: the
  // console operator is never the spawner.
  const handlePause = useCallback(
    (p: Presence) => {
      const op = pausedIds.has(p.card.id) ? "resume" : "pause";
      void ctl(op, { name: p.card.name }, CONTROL_ADMIN)
        .then((r) => {
          setNotice(r.ok ? `${op === "pause" ? "paused" : "resumed"} ${p.card.name}` : `${op}: ${r.error ?? "failed"}`);
          if (r.ok)
            setPausedIds((prev) => {
              const next = new Set(prev);
              if (op === "pause") next.add(p.card.id);
              else next.delete(p.card.id);
              return next;
            });
        })
        .catch((e) => setNotice(`${op}: ` + (e as Error).message));
    },
    [ctl, pausedIds],
  );
  // Attach: open the agent's live PTY. Keyed by NAME (a manager-managed agent needn't be a mesh
  // roster peer — same as `cotal attach --name`). Resolve the manager's loopback WS via the attach
  // control op (admin tier + per-action mint, like kill/pause), then suspend the console.
  const handleAttach = useCallback(
    (name: string) => {
      if (!canControl) return setNotice("no control authority — pass --creds, or run against a mesh whose auth you hold");
      // Validate COTAL_DETACH_KEY before suspending: a bad value stays a notice (never blanks the
      // screen, never exits the console — attachClient would only throw it after the takeover).
      try {
        detachKey();
      } catch (e) {
        return setNotice("attach: " + (e as Error).message);
      }
      setNotice(`attaching to ${name}…`);
      void ctl("attach", { name }, CONTROL_ADMIN)
        .then((r) => {
          const ws = (r.data as { ws?: string } | undefined)?.ws;
          if (!r.ok || !ws) return setNotice(`attach: ${r.error ?? "no ws endpoint"}`);
          setAttachTarget({ name, ws });
        })
        .catch((e) => setNotice("attach: " + (e as Error).message));
    },
    [canControl, ctl],
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

  // First time the operator sends anything, upgrade the read-only observer into a participant:
  // register presence (so agents see + can reply to the operator) and reveal/capture its own
  // inbox in the DM lens. Idempotent, canWrite-gated (a pure-watch session never calls it).
  const activatedRef = useRef(false);
  const ensureParticipant = useCallback(async () => {
    if (activatedRef.current || !canWrite) return;
    activatedRef.current = true;
    try {
      await ep.startPresence();
      activateParticipant(ep.card.id, ep.card.name);
      setNotice("you're on the roster now — replies show in the DM lens (d)");
    } catch (e) {
      activatedRef.current = false; // let the next send retry
      setNotice("participant: " + (e as Error).message);
    }
  }, [ep, activateParticipant, canWrite]);

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
      else if (c.kind === "dm") {
        recordOutboundDm(c.toId, text); // show our own side of the thread
        void ep.unicast(c.toId, text).then(ok("→ " + c.toName)).catch(fail);
      } else {
        const e = c.entry;
        let send: Promise<unknown>;
        if (e.delivery === "multicast" && e.channel) {
          send = ep.multicast(text, { channel: e.channel, replyTo: e.id, mentions: mentionsIn(text) });
        } else {
          recordOutboundDm(e.from.id, text); // show our own side of the thread
          send = ep.unicast(e.from.id, text, { replyTo: e.id });
        }
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
      confirmPurge: () => setConfirm({ kind: "purge", space: ep.space }),
      ensureParticipant,
      recordOutboundDm,
      startAttach: handleAttach,
    };
    runCommand(line, ctx, !!canWrite, !!canControl);
  };

  // Confirmed destructive action (kill/purge; space-delete is handled in the picker). Kill goes
  // on the ADMIN tier with a per-action mint — the privileged tier only reaches a caller's own
  // spawned child, and the console's observer cred can't publish control at all.
  const onConfirmed = (opts?: { force?: boolean }) => {
    const c = confirm;
    setConfirm(null);
    if (c?.kind === "kill") {
      const graceful = !opts?.force;
      void ctl("stop", { name: c.name, graceful }, CONTROL_ADMIN)
        .then((r) => setNotice(r.ok ? `${graceful ? "stopped" : "force-killed"} ${c.name}` : `stop: ${r.error ?? "failed"}`))
        .catch((e) => setNotice("stop: " + (e as Error).message));
    } else if (c?.kind === "purge") {
      void ctl("purge", {}, CONTROL_ADMIN)
        .then((r) => setNotice(r.ok ? "purged space history" : `purge: ${r.error ?? "failed"}`))
        .catch((e) => setNotice("purge: " + (e as Error).message));
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
        if (mode === "dm" || mode === "topo" || mode === "views") return setMode("normal");
        if (railOverlay) return setRailOpen(false);
        if (search.query) return setSearch({ active: false, query: "" });
        if (onBack) return onBack();
        return;
      }
      if (input === "q") return exit();
      if (onBack && input === "b" && mode === "normal") return onBack(); // quick back to the overview
      if (input === "d" && !key.ctrl) return setMode((m) => (m === "dm" ? "normal" : "dm")); // Ctrl-d = scroll
      if (input === "t") return setMode((m) => (m === "topo" ? "normal" : "topo"));
      if (input === "V") return setMode((m) => (m === "views" ? "normal" : "views")); // peer-pushed views
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

  // Attached: render nothing so Ink releases stdin/stdout to the agent PTY (the suspend effect owns
  // the terminal). App stays mounted → the observer endpoint + MeshView survive in the background.
  if (attachTarget) return null;
  if (helpOpen) return <Help focusedId={focusedId} width={size.cols} height={size.rows} />;
  if (detail) return <Detail target={detail} feed={mesh.feed} width={size.cols} height={size.rows} />;
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
      <Tabs tabs={tabs} active={activeChannel} counts={counts} width={size.cols} />
      {/* Golden-signal strip — rendered through json-render's Ink catalog (dogfoods the same
          renderer that paints peer-pushed views). */}
      <SpecView spec={tilesSpec(mesh.signals.counts, mesh.signals.oldestWaitingTs, size.cols)} />
      {mode === "views" ? (
        <Views views={mesh.views} width={size.cols} height={bodyH} />
      ) : mode === "dm" ? (
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
              onPause={canControl ? handlePause : undefined}
              onAttach={canControl ? (p) => handleAttach(p.card.name) : undefined}
              paused={pausedIds}
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
        width={size.cols}
      />
    </Box>
  );
}
