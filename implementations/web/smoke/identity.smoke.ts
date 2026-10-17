/** The initial badge (mock B2), which tells agents that draw the same character apart. Sections 1
 *  to 3 call the pure module: the letter, the colour slot from the name's hash, and the slots a set
 *  of roster rows gets when names clash. Section 4 renders the badge and an avatar that carries one.
 *  Section 5 renders the real shell over a seeded store with two Claude agents and reads the badges
 *  its message rows and Members rows draw, including that a history row (no verified sender) draws
 *  none. Section 6 renders the Topology tab, and the topology view with Hide offline off, under the
 *  lookup the shell provides and reads the badge on each agent node, an offline one included. */
import { closeDom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { ChannelInfo, CotalMessage, MembershipSnapshot, RosterEntry } from "../client/src/api/types.js";
import { assignSlots, initials, slotOf } from "../client/src/lib/identity.js";
import { rosterRows, type Status } from "../client/src/lib/roster.js";
import type { Route } from "../client/src/lib/route.js";
import { createStore } from "../client/src/state/store.js";
import { initialState, type DashboardState, type StoredMessage } from "../client/src/state/types.js";
import { Avatar } from "../client/src/ui/Avatar.tsx";
import { IdentityBadge } from "../client/src/ui/IdentityBadge.tsx";
import { BadgeOf, badgeLookup } from "../client/src/ui/identity.js";
import { TopologyTab } from "../client/src/ui/panel/TopologyTab.tsx";
import { TopologyView } from "../client/src/ui/views/TopologyView.tsx";
import { renderShell } from "./render-shell.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};
const same = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

/** `html` parsed into a detached element, so a cell reads elements and classes instead of text. */
const parse = (html: string): HTMLElement => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
};
const all = (el: ParentNode, sel: string) => [...el.querySelectorAll(sel)] as HTMLElement[];
/** A badge as a cell compares it: its class, its style (which names its fill) and its text. */
const badgeView = (el: Element | null) => el === null ? null : { cls: el.getAttribute("class"), style: el.getAttribute("style"), text: el.textContent };

// ── 1. The letter ────────────────────────────────────────────────────────────────────────────────
same("1.1 lead gives L", initials("lead"), "L");
same("1.2 reviewer_2 gives R2", initials("reviewer_2"), "R2");
same("1.3 ui gives U", initials("ui"), "U");
same("1.4 Ada Lovelace gives A", initials("Ada Lovelace"), "A");
same("1.5 an empty name gives an empty letter", initials(""), "");

// ── 2. The slot from the name ────────────────────────────────────────────────────────────────────
/** The mock's eight Claude agents. */
const MOCK = ["lead", "engine", "ui", "tester", "docs", "reviewer", "reviewer_2", "perf"];
{
  const names = [...MOCK, "", "a", "Ada Lovelace", "agent-with-a-long-name_12", "élan", "名前"];
  const slots = names.map(slotOf);
  ok("2.1 every slot is a whole number from 1 to 8", slots.every((s) => Number.isInteger(s) && s >= 1 && s <= 8), slots);
  ok("2.2 one name always gets one slot", names.every((name) => slotOf(name) === slotOf(name)), names);
  // The mock's helper, `hash(n) % 8` from h = 7 and h = h * 31 + code, plus one for 1-based slots,
  // over its eight names, worked out once and written down here so a changed hash reddens.
  same("2.3 the slot is the mock's hash of the name", MOCK.map(slotOf), [4, 2, 4, 7, 3, 5, 8, 1]);
}

// ── 3. Slots for a roster ────────────────────────────────────────────────────────────────────────
const row = (id: string, name: string, status: Status = "working") => ({ id, name, status });
const asObject = (m: Map<string, number>) => Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
{
  // lead and ui both hash to slot 4. In name order lead comes first, so ui moves to the next free one.
  same("3.1 two live agents whose names share a slot get different slots, and the later in name order moves",
    asObject(assignSlots([row("a.lead", "lead"), row("a.ui", "ui")])), { "a.lead": 4, "a.ui": 5 });
  // The mock's eight fill every slot (ui moves past lead's 4 and reviewer's 5 to 6); zed hashes to 3,
  // which docs holds, and with no slot left keeps its own.
  same("3.2 a ninth live agent keeps its own slot once all eight are taken, so colours repeat",
    asObject(assignSlots([...[...MOCK].sort().map((name) => row(`a.${name}`, name)), row("a.zed", "zed")])),
    { "a.docs": 3, "a.engine": 2, "a.lead": 4, "a.perf": 1, "a.reviewer": 5, "a.reviewer_2": 8, "a.tester": 7, "a.ui": 6, "a.zed": 3 });
  same("3.3 an offline agent keeps its own slot even while a live agent holds it",
    asObject(assignSlots([row("a.lead", "lead"), row("a.ui", "ui", "offline")])), { "a.lead": 4, "a.ui": 4 });
  same("3.4 the same rows in another order get the same slots",
    [asObject(assignSlots([row("a.lead", "lead"), row("a.ui", "ui")])), asObject(assignSlots([row("a.ui", "ui"), row("a.lead", "lead")]))],
    [{ "a.lead": 4, "a.ui": 5 }, { "a.lead": 4, "a.ui": 5 }]);
  same("3.5 two agents with one name are taken in id order",
    asObject(assignSlots([row("z.lead", "lead"), row("a.lead", "lead")])), { "a.lead": 4, "z.lead": 5 });
}

// ── 4. The badge, drawn ──────────────────────────────────────────────────────────────────────────
{
  const at = (size: number, offline = false, letter = "E") =>
    parse(renderToString(createElement(IdentityBadge, { letter, slot: 2, size, offline }))).querySelector("i");
  same("4.1 at 34px the badge shows its letter on its slot's fill", badgeView(at(34)), { cls: "ui-idb", style: "--bf:var(--id-2)", text: "E" });
  same("4.2 under 26px the badge is a colour dot with no letter", badgeView(at(22)), { cls: "ui-idb ui-idb-dot", style: "--bf:var(--id-2)", text: "" });
  same("4.3 offline greys the badge and keeps its letter", badgeView(at(34, true)), { cls: "ui-idb ui-idb-off", style: "--bf:var(--id-2)", text: "E" });
  ok("4.4 the badge is hidden from assistive technology", at(34)?.getAttribute("aria-hidden") === "true" && at(22)?.getAttribute("aria-hidden") === "true");
  same("4.5 a two-character letter gets the smaller type", badgeView(at(34, false, "R2")), { cls: "ui-idb ui-idb-2", style: "--bf:var(--id-2)", text: "R2" });
  const av = parse(renderToString(createElement(Avatar, { vendor: "claude-code", status: "working", size: 36, badge: { letter: "L", slot: 4 } }))).querySelector(".ui-av");
  same("4.6 an avatar draws the character, then the badge, then the status dot",
    [...(av?.children ?? [])].map((c) => c.getAttribute("class") ?? c.tagName.toLowerCase()), ["svg", "ui-idb", "ui-st ui-st-working"]);
  ok("4.7 an avatar with no badge draws none", parse(renderToString(createElement(Avatar, { vendor: "claude-code", status: "working", size: 36 }))).querySelector(".ui-idb") === null);
}

// ── 5. The shell: two Claude agents in #team ─────────────────────────────────────────────────────
const entry = (id: string, name: string, status: RosterEntry["status"]): RosterEntry =>
  ({ card: { id, name, kind: "agent", role: name, meta: { connector: "claude-code" } }, status, ts: 1 }) as RosterEntry;
const ROSTER = [entry("local.lead", "lead", "idle"), entry("local.ui", "ui", "working")];
const team: ChannelInfo = { channel: "team", messages: 3, replay: false, deliveryClass: "live" };
const teamMembers = {
  asOf: Date.now(),
  members: [
    { id: "local.lead", live: ["team"], durable: [], observedAt: 1 },
    { id: "local.ui", live: ["team"], durable: [], observedAt: 1 },
  ],
} as unknown as MembershipSnapshot;
const msg = (id: string, from: string, text: string, ts: number): CotalMessage =>
  ({ id, ts, space: "main", from: { id: from, name: "mallory" }, channel: "team", parts: [{ kind: "text", text }] }) as unknown as CotalMessage;
const now = Date.now();
const MESSAGES: StoredMessage[] = [
  { msg: msg("m1", "local.lead", "Engine first, then the board.", now - 3000), senderId: "local.lead" },
  { msg: msg("m2", "local.ui", "Board is up.", now - 2000), senderId: "local.ui" },
  // From history: the payload names lead, a roster id, but nothing verified the sender.
  { msg: msg("m3", "local.lead", "Read from history.", now - 1000) },
];
const seed: Partial<DashboardState> = { space: "main", roster: ROSTER, channels: [team], membership: { snapshot: teamMembers }, open: { channel: "team", messages: MESSAGES } };
const teamRoute: Route = { view: "channel", channel: "team" };
{
  const shell = parse(renderShell(seed, teamRoute, true));
  const rows = all(shell, "main.ui-center .ui-msg");
  const rowBadge = (i: number) => badgeView(rows[i]?.querySelector(".ui-gut .ui-idb") ?? null);
  // lead and ui share slot 4 by hash; in name order ui moves to 5.
  same("5.1 the message rows draw a different slot for each Claude agent",
    [rowBadge(0), rowBadge(1)], [{ cls: "ui-idb", style: "--bf:var(--id-4)", text: "L" }, { cls: "ui-idb", style: "--bf:var(--id-5)", text: "U" }]);
  same("5.2 the Members rows draw the same slots",
    all(shell, ".v3-mrow").map((r) => [r.dataset.member, badgeView(r.querySelector(".ui-idb"))]),
    [["local.ui", { cls: "ui-idb", style: "--bf:var(--id-5)", text: "U" }], ["local.lead", { cls: "ui-idb", style: "--bf:var(--id-4)", text: "L" }]]);
  ok("5.3 a live row with a verified sender has a badge and a history row has none",
    rows.length === 3 && rowBadge(0) !== null && rowBadge(2) === null && rows[2].querySelector(".ui-unverified") !== null, rows.map((_, i) => rowBadge(i)));
}

// ── 6. The Topology tab ──────────────────────────────────────────────────────────────────────────
{
  // perf is offline and in #team. The tab hides offline agents, so it draws lead and ui; the view with
  // Hide offline off draws perf too, whose badge sits outside the greyscale art group, filled grey.
  const roster = [...ROSTER, entry("local.perf", "perf", "offline")];
  const members = { ...teamMembers, members: [...teamMembers.members, { id: "local.perf", live: ["team"], durable: [], observedAt: 1 }] } as MembershipSnapshot;
  const store = createStore<DashboardState>({ ...initialState, ...seed, roster, membership: { snapshot: members } });
  const lookup = badgeLookup(rosterRows(roster, { includeOffline: true }));
  const under = (el: ReturnType<typeof createElement>) => parse(renderToString(createElement(BadgeOf.Provider, { value: lookup }, el)));
  /** Each agent node: its id, whether its badge sits inside the art group, the circle's style and the letter. */
  const nodes = (root: HTMLElement) => all(root, "g.ui-ta")
    .map((g) => [g.dataset.node, g.querySelector(".ui-ta-art .ui-tidb") !== null, g.querySelector(".ui-tidb circle")?.getAttribute("style") ?? null, g.querySelector(".ui-tidb text")?.textContent ?? null])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  const tab = under(createElement(TopologyTab, { store, clock: () => now }));
  const view = under(createElement(TopologyView, { store, clock: () => now, initialHideOffline: false }));
  same("6.1 the Topology tab draws a badge circle with its letter on each agent node, and an offline node's badge is grey and outside the greyscale group",
    [nodes(tab), nodes(view)],
    [
      [["local.lead", false, "fill:var(--id-4)", "L"], ["local.ui", false, "fill:var(--id-5)", "U"]],
      [["local.lead", false, "fill:var(--id-4)", "L"], ["local.perf", false, "fill:var(--id-off)", "P"], ["local.ui", false, "fill:var(--id-5)", "U"]],
    ]);
}

await closeDom();
console.log(`identity: ${n} cells passed`);
