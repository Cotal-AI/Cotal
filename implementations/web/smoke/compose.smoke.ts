/** The composer (mock section B, the composer states, and section D's dock): where a view posts, the
 *  copy under the box for each capability, the controller's `send` with the faded row and the draft
 *  that survives a refusal, the composer's four states drawn with one structure, the Message buttons
 *  that open the DM view with the composer focused, and the sidebar footer's place on the roster.
 *
 *  Section 1 calls the modules, section 2 drives the shipped controller over a fake `Api`, section 3
 *  renders the shell over a seeded store, and section 4 mounts it in jsdom and clicks. The server's
 *  answers are the ones `POST /api/send` gives (smoke:web-send pins the route itself). Section 6 is
 *  the page learning the operator's id when the operator joins after it loaded. */
import { closeDom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createElement, useState } from "react";
import { renderToString } from "react-dom/server";
import type { ChannelInfo, CotalMessage, MembershipSnapshot, Meta, RosterEntry, SendAnswer } from "../client/src/api/types.js";
import { httpApi } from "../client/src/api/http.js";
import { composeKey, composerNote, composeTarget, footerLine, messageRoute, POST_OFF_CREDS as CLIENT_POST_OFF_CREDS, refusalText, SendRefused, sendCommand, shellArg } from "../client/src/lib/compose.js";
import { displayNameOf, nameIndex } from "../client/src/lib/names.js";
import { formatRoute, parseRoute, type Route } from "../client/src/lib/route.js";
import { Shell } from "../client/src/Shell.tsx";
import type { Api, Controller } from "../client/src/state/controller.js";
import { createStore, type Store } from "../client/src/state/store.js";
import { initialState, type DashboardState, type Draft } from "../client/src/state/types.js";
import { Compose, Composer, focusComposer } from "../client/src/ui/Composer.tsx";
import { AgentTab } from "../client/src/ui/panel/AgentTab.tsx";
import { bootReads, gate, harness, page } from "./controller-harness.js";
import { mount } from "./mount.js";
import { renderShell } from "./render-shell.js";

const { POST_OFF_CREDS, POST_OFF_EXPIRED, POST_OFF_USER } = await import("../src/web.js");

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};
const same = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────
const OP = "local.op";
const entry = (id: string, name: string, status: RosterEntry["status"], extra: { connector?: string; role?: string; activity?: string; statusSince?: number; kind?: string } = {}): RosterEntry =>
  ({
    card: { id, name, kind: extra.kind ?? "agent", role: extra.role, meta: extra.connector ? { connector: extra.connector } : {} },
    status,
    ts: 1,
    activity: extra.activity,
    statusSince: extra.statusSince,
  }) as RosterEntry;
const roster: RosterEntry[] = [
  entry("local.dav", "david", "working", { connector: "claude-code", role: "engineer" }),
  entry("local.rev", "reviewer", "idle", { connector: "codex", role: "reviewer" }),
  entry("local.rv2", "reviewer_2", "idle", { connector: "opencode", role: "reviewer" }),
];
const operator = entry(OP, "operator", "idle", { kind: "endpoint", role: "operator" });
const waitingRv2 = roster.map((p) => (p.card.id === "local.rv2" ? { ...p, status: "waiting" as const, activity: "Needs approval to run pnpm smoke:ci", statusSince: 1 } : p));
const review: ChannelInfo = { channel: "review", messages: 1, replay: false, deliveryClass: "live" };
const members: MembershipSnapshot = {
  asOf: Date.now(),
  members: [
    { id: "local.rev", live: ["review"], durable: [], observedAt: 1 },
    { id: "local.dav", live: [], durable: ["review"], observedAt: 1 },
    { id: "local.rv2", live: ["review"], durable: [], observedAt: 1 },
  ],
} as unknown as MembershipSnapshot;
const msg = (id: string, from: string, text: string, extra: Partial<CotalMessage> = {}): CotalMessage =>
  ({ id, ts: Date.now(), space: "main", from: { id: from, name: "mallory" }, parts: [{ kind: "text", text }], ...extra }) as unknown as CotalMessage;
const PARTICIPANT = { mode: "participant" } as const;
const CREDS_OFF = { mode: "off", reason: POST_OFF_CREDS } as const;
const USER_OFF = { mode: "off", reason: POST_OFF_USER } as const;
const REVIEW = { kind: "msg", channel: "review" } as const;
const RV2 = { kind: "dm", to: "local.rv2" } as const;
const seed = (patch: Partial<DashboardState> = {}): Partial<DashboardState> => ({
  space: "main",
  roster,
  channels: [review],
  membership: { snapshot: members },
  open: { channel: "review", messages: [] },
  post: PARTICIPANT,
  ...patch,
});
const channelRoute: Route = { view: "channel", channel: "review" };
const rv2Route: Route = { view: "dm", peer: "local.rv2" };
const BROKER = "Permissions Violation for Publish to cotal.main.chat.review";

const parse = (html: string): HTMLElement => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
};
const none = (): HTMLElement => document.createElement("div");
const textOf = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
/** A started dashboard's controller, so a drawn composer can send as it does in the page. */
const started = harness({}).ctl;
/** The centre of the shell over `seed(patch)` at `route`, drawn on the server with a controller. */
const centre = (patch: Partial<DashboardState>, route: Route = channelRoute) => {
  const store = createStore<DashboardState>({ ...initialState, ...seed(patch) });
  const html = renderToString(createElement(Shell, { store, controller: started, route, paneOpen: route.view === "channel", msgPerSecond: () => 0 }));
  return (parse(html).querySelector("main.ui-center") as HTMLElement | null) ?? none();
};
const dockOf = (c: Element) => c.querySelector(".ui-dock .ui-dock-in") ?? none();
const card = (c: Element) => c.querySelector(".ui-card.ui-composer") ?? none();
const note = (c: Element) => c.querySelector(".ui-cnote") ?? none();
const draftOf = (text: string, extra: Partial<Draft> = {}): Draft => ({ text, outgoing: [], ...extra });

// ── 1. Where a view posts, and what is said ──────────────────────────────────────────────────────
{
  same("1.1 a channel route posts to its channel", composeTarget(channelRoute), REVIEW);
  same("1.2 a DM route posts to the agent it names, by id", composeTarget(rv2Route), RV2);
  ok("1.3 Activity, and every view that is not a channel or a DM, has no composer",
    composeTarget({ view: "activity" }) === undefined && composeTarget({ view: "agents", group: "status" }) === undefined, composeTarget({ view: "activity" }));
  same("1.4 a conversation that names the operator posts to the other side, whichever side the route names first",
    [composeTarget({ view: "dm", peer: OP, with: "local.rv2" }, OP), composeTarget({ view: "dm", peer: "local.rv2", with: OP }, OP)], [RV2, RV2]);
  same("1.5 a conversation between two agents, or the operator alone, has no composer",
    [composeTarget({ view: "dm", peer: "local.rev", with: "local.rv2" }, OP), composeTarget({ view: "dm", peer: OP }, OP)], [undefined, undefined]);
  same("1.6 a dashboard that posts says the participant line",
    composerNote(PARTICIPANT), "You'll show on the roster as operator when you post. Replies come to your DMs.");
  same("1.7 posting off with --creds says how to post here, with the command parts as code", composerNote(CREDS_OFF), "Restart `cotal web` without `--creds` to post here.");
  same("1.8 posting off on a sign-in mesh adds nothing under the reason the composer already shows", composerNote(USER_OFF), "");
  same("1.9 the client's --creds reason is the server's own", CLIENT_POST_OFF_CREDS, POST_OFF_CREDS);
  const idx = nameIndex(roster);
  same("1.10 the operator's id reads operator (you) while the roster does not hold it", displayNameOf(OP, idx, OP), "operator (you)");
  same("1.11 once the roster names it, that name, and with no selfId the id is not called you",
    [displayNameOf(OP, nameIndex([...roster, operator]), OP), displayNameOf(OP, idx) === "operator (you)"], ["operator", false]);
  same("1.12 a 502 is the broker's refusal, ending in one period",
    refusalText("#review", new SendRefused(502, "permissions violation for publish")),
    "Couldn't post to #review. The broker refused it: permissions violation for publish. Your message is still here.");
  same("1.13 a 403 is said as it came, and the server's own period is not doubled",
    refusalText("reviewer_2", new SendRefused(403, POST_OFF_EXPIRED)),
    "Couldn't post to reviewer_2. The operator credential expired. Restart cotal web to post again. Your message is still here.");
  same("1.14 a 400 is never called the broker's", refusalText("#review", new SendRefused(400, "text required")), "Couldn't post to #review. text required. Your message is still here.");
  same("1.15 the footer line: nothing before /api/meta, then Not on the roster, On the roster, and Read only with the reason",
    [footerLine(null, false), footerLine(PARTICIPANT, false)?.text, footerLine(PARTICIPANT, true)?.text, footerLine(CREDS_OFF, false)],
    [undefined, "Not on the roster", "On the roster", { text: "Read only", title: POST_OFF_CREDS }]);
  // A hostile id or channel name, read back by a real shell: it must stay one word and mean itself.
  // A shell that cannot parse the line is an answer too, so it is reported rather than thrown. Run from
  // the temp directory, so a mutant that leaves a word bare runs `true` there and nothing else.
  const words = (line: string) => {
    try {
      return execFileSync("/bin/sh", ["-c", `for w in ${line}; do printf '%s\\n' "$w"; done`], { encoding: "utf8", cwd: tmpdir(), stdio: ["ignore", "pipe", "ignore"] }).split("\n").slice(0, -1);
    } catch (e) {
      return [`the shell refused it: ${(e as Error).message.split("\n")[0]}`];
    }
  };
  const hostile = "local.x'; true; echo $(echo hi) `echo hi` \"q\"";
  same("1.16 a command names an agent by id and a channel by name as one shell word each, safe ones bare and hostile ones quoted, and the shell reads each back as itself",
    [sendCommand({ kind: "dm", to: "local.rv2" }), sendCommand({ kind: "msg", channel: "review" }), words(shellArg(hostile)), words(sendCommand({ kind: "dm", to: hostile }).slice("cotal send dm ".length, -' "<text>"'.length)),
      words(sendCommand({ kind: "msg", channel: "rev;iew" }).slice("cotal send msg ".length, -' "<text>"'.length))],
    ['cotal send dm local.rv2 "<text>"', 'cotal send msg review "<text>"', [hostile], [hostile], ["rev;iew"]]);
  same("1.17 a server sentence ending in a question or exclamation mark gets no period after it",
    [refusalText("#review", new SendRefused(400, "is this a channel?")), refusalText("#review", new SendRefused(400, "no!"))],
    ["Couldn't post to #review. is this a channel? Your message is still here.", "Couldn't post to #review. no! Your message is still here."]);
}

// ── 2. The controller's send ─────────────────────────────────────────────────────────────────────
const answer = (id: string, operatorId = OP): SendAnswer => ({ ok: true, id, operatorId });
{
  const g = gate<SendAnswer>();
  const sent: unknown[] = [];
  const h = harness({ send: (t, text) => { sent.push([t, text]); return g.promise; } });
  h.store.set({ roster, drafts: { [composeKey(REVIEW)]: draftOf("Approved. Run it.") } });
  const done = h.ctl.send(REVIEW, "Approved. Run it.");
  const during = h.store.get().drafts[composeKey(REVIEW)];
  ok("2.1 a post empties the box and is held as a row the server has not answered",
    during.text === "" && during.outgoing.length === 1 && during.outgoing[0].text === "Approved. Run it." && during.outgoing[0].id === undefined, during);
  same("2.2 and the post goes to the server as given", sent, [[REVIEW, "Approved. Run it."]]);
  // Not awaited: a second post that did go out would wait on the first one's answer.
  let second: unknown;
  h.ctl.send(REVIEW, "again").catch((e) => { second = e; });
  await new Promise((r) => setTimeout(r, 0));
  ok("2.3 a second post to the same target while one is in flight is refused in the page", second instanceof Error && sent.length === 1, sent);
  g.resolve(answer("m-1"));
  await done;
  const after = h.store.get();
  ok("2.4 the answer marks the row sent, and an open mesh learns the operator's id from it",
    after.drafts[composeKey(REVIEW)].outgoing[0]?.id === "m-1" && after.operatorId === OP, after.drafts);
  h.ctl.onMessage({ mode: "chat", channel: "review", senderId: OP, msg: msg("m-1", OP, "Approved. Run it.") });
  same("2.5 the row goes once the feed delivers the message itself", h.store.get().drafts[composeKey(REVIEW)].outgoing, []);
}
{
  const h = harness({ send: async () => { throw new SendRefused(502, BROKER); } });
  h.store.set({ roster });
  let thrown: unknown;
  await h.ctl.send(REVIEW, "Approved. Run it on build-box.").catch((e) => { thrown = e; });
  const d = h.store.get().drafts[composeKey(REVIEW)];
  ok("2.6 THE DRAFT SURVIVES A REFUSAL: the text is back in the box and no row is left", d.text === "Approved. Run it on build-box." && d.outgoing.length === 0, d);
  same("2.7 and a 502 sets the broker's refusal copy", d.refused, `Couldn't post to #review. The broker refused it: ${BROKER}. Your message is still here.`);
  ok("2.8 and send rethrows the server's error", thrown instanceof SendRefused && thrown.status === 502, thrown);
  h.ctl.draft(REVIEW, "Approved. Run it on build-box, please.");
  ok("2.9 editing the refused draft clears the refusal", h.store.get().drafts[composeKey(REVIEW)].refused === undefined, h.store.get().drafts);
}
{
  const h = harness({ send: async () => { throw new SendRefused(403, POST_OFF_EXPIRED); } });
  h.store.set({ roster });
  await h.ctl.send(RV2, "hi").catch(() => undefined);
  same("2.10 a refused DM names the agent by its roster name, and a 403 is not called the broker's",
    h.store.get().drafts[composeKey(RV2)].refused, "Couldn't post to reviewer_2. The operator credential expired. Restart cotal web to post again. Your message is still here.");
}
{
  const h = harness({ meta: async () => ({ space: "main", pid: 1, post: CREDS_OFF }), roster: async () => [], channels: async () => [], activity: async () => page(), dms: async () => [], membership: async () => ({ members: [] }) as never });
  await h.ctl.refresh();
  same("2.11 /api/meta's capability reaches the store", h.store.get().post, CREDS_OFF);
  const s = harness({ meta: async () => ({ space: "main", pid: 1, post: PARTICIPANT, operatorId: OP }), roster: async () => [], channels: async () => [], activity: async () => page(), dms: async () => [], membership: async () => ({ members: [] }) as never, send: async () => answer("m-2", "local.other") });
  await s.ctl.refresh();
  await s.ctl.send(REVIEW, "x");
  same("2.12 a static mesh's operator id comes from /api/meta, and the one that arrived first is kept", s.store.get().operatorId, OP);
}
{
  const h = harness({ send: async () => answer("m-3") });
  h.ctl.onMessage({ mode: "chat", channel: "review", senderId: OP, msg: msg("m-3", OP, "fast") });
  await h.ctl.send(REVIEW, "fast");
  same("2.13 a post the feed delivered before the answer came leaves no row behind", h.store.get().drafts[composeKey(REVIEW)].outgoing, []);
}
{
  const dm = msg("m-7", OP, "missed by the feed", { to: "local.rv2" });
  const h = harness({ send: async () => answer("m-7"), meta: async () => ({ space: "main", pid: 1, post: PARTICIPANT }), roster: async () => [], channels: async () => [],
    activity: async () => page(), dms: async () => [dm], membership: async () => ({ members: [] }) as never });
  await h.ctl.send(RV2, "missed by the feed");
  const before = h.store.get().drafts[composeKey(RV2)].outgoing.length;
  await h.ctl.refresh();
  same("2.16 an answered post the feed never delivered goes once a refresh reads it back", [before, h.store.get().drafts[composeKey(RV2)].outgoing], [1, []]);
  const c = harness({ send: async () => answer("m-8"), history: async () => [msg("m-8", OP, "in history", { channel: "review" })] });
  await c.ctl.send(REVIEW, "in history");
  await c.ctl.open("review");
  same("2.17 and so does one a channel load reads back", c.store.get().drafts[composeKey(REVIEW)].outgoing, []);
}
{
  const calls: { url: string; init?: RequestInit }[] = [];
  const reply = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body }) as unknown as Response;
  let next = reply(200, answer("m-4"));
  const api = httpApi((async (url: string, init?: RequestInit) => { calls.push({ url, init }); return next; }) as typeof fetch);
  const got = await api.send(RV2, "hello");
  same("2.14 send posts its target and text as JSON to /api/send and hands back the answer",
    [calls[0]?.url, calls[0]?.init?.method, JSON.parse(String(calls[0]?.init?.body)), got], ["/api/send", "POST", { kind: "dm", to: "local.rv2", text: "hello" }, answer("m-4")]);
  next = reply(502, { error: BROKER });
  const refused = await api.send(REVIEW, "x").catch((e: unknown) => e);
  ok("2.15 a refusal throws with its status and the server's text kept apart", refused instanceof SendRefused && refused.status === 502 && refused.error === BROKER, refused);
}

// ── 3. The composer, drawn ───────────────────────────────────────────────────────────────────────
{
  const c = centre({});
  const k = card(c);
  const box = k.querySelector("textarea") as HTMLTextAreaElement | null;
  ok("3.1 the live box is a textarea whose placeholder is Message #review", box?.placeholder === "Message #review" && box.getAttribute("aria-label") === "Message #review", box?.outerHTML);
  same("3.2 its row is Mention, the mode line, as operator and send",
    [...k.querySelectorAll(".ui-crow > *")].map((x) => [x.tagName, x.className, textOf(x), x.getAttribute("title")]),
    [["BUTTON", "ui-pick", "Mention", null], ["SPAN", "ui-sp", "", null], ["SPAN", "ui-pick", "to #review · 3 members", null], ["SPAN", "ui-pick", "as operator", null], ["BUTTON", "ui-send", "", "Send"]]);
  ok("3.3 the mode line counts the header's members and carries the channel's blue dot",
    textOf(c.querySelector("header .ui-members")) === "3" && (k.querySelector(".ui-mode-dot") as HTMLElement | null)?.getAttribute("style")?.includes("var(--multi)") === true);
  same("3.4 under it, the participant line", textOf(note(c)), "You'll show on the roster as operator when you post. Replies come to your DMs.");
  ok("3.5 an empty box cannot be sent", (k.querySelector("button.ui-send") as HTMLButtonElement).disabled === true);
  ok("3.6 nothing is drawn until /api/meta has said what the dashboard can post as",
    centre({ post: null }).querySelector(".ui-composer") === null && centre({ post: null }).querySelector(".ui-dock") === null);
}
{
  const c = centre({ post: CREDS_OFF });
  const k = card(c);
  ok("3.7 --creds: the reason with --creds as code, behind a lock", textOf(k.querySelector(".ui-reason")) === POST_OFF_CREDS && k.querySelector(".ui-reason code")?.textContent === "--creds" && k.getAttribute("aria-disabled") === "true");
  same("3.8 the command that posts from a terminal, and a disabled send whose tooltip is the reason",
    [textOf(k.querySelector(".ui-cmd code")), (k.querySelector("button.ui-send") as HTMLButtonElement | null)?.disabled, k.querySelector("button.ui-send")?.getAttribute("title")],
    ['cotal send msg review "<text>"', true, POST_OFF_CREDS]);
  same("3.9 and the note says to restart without --creds, with both as code",
    [textOf(note(c)), [...note(c).querySelectorAll("code")].map((x) => x.textContent)], ["Restart cotal web without --creds to post here.", ["cotal web", "--creds"]]);
  const u = centre({ post: USER_OFF });
  same("3.10 a sign-in mesh shows the server's reason as it came, and an empty note", [textOf(card(u).querySelector(".ui-reason")), textOf(note(u))], [POST_OFF_USER, ""]);
}
{
  const inflight = { [composeKey(REVIEW)]: draftOf("And the next one", { outgoing: [{ seq: 1, text: "Approved. Run it.", ts: Date.now() }] }) };
  const c = centre({ drafts: inflight });
  const send = card(c).querySelector("button.ui-send") as HTMLButtonElement | null;
  ok("3.11 THE SEND BUTTON IS DISABLED WHILE A SEND IS IN FLIGHT, though the box holds text, and it spins",
    send?.disabled === true && send.getAttribute("title") === "Sending" && send.querySelector(".ui-spin") !== null, send?.outerHTML);
  const pending = c.querySelector(".ui-col .ui-msg.ui-pending") ?? none();
  same("3.12 THE FADED SENDING ROW: the post shows as the operator's, faded, until the server answers",
    [textOf(pending.querySelector(".ui-me")), textOf(pending.querySelector(".ui-mh b")), textOf(pending.querySelector(".ui-role")), textOf(pending.querySelector(".ui-tx"))],
    ["OP", "operator", "operator", "Approved. Run it."]);
  const answered = centre({ drafts: { [composeKey(REVIEW)]: draftOf("", { outgoing: [{ seq: 1, text: "Approved. Run it.", ts: Date.now(), id: "m-9" }] }) } });
  ok("3.13 once answered it is no longer faded, until the list holds the message itself",
    answered.querySelector(".ui-col .ui-pending") === null && textOf(answered.querySelector(".ui-col .ui-msg .ui-tx")) === "Approved. Run it.");
  const arrived = centre({
    open: { channel: "review", messages: [{ msg: msg("m-9", OP, "Approved. Run it.", { channel: "review" }), senderId: OP }] },
    drafts: { [composeKey(REVIEW)]: draftOf("", { outgoing: [{ seq: 1, text: "Approved. Run it.", ts: Date.now(), id: "m-9" }] }) },
  });
  ok("3.14 and once it does, the post is drawn once", arrived.querySelectorAll(".ui-col .ui-msg").length === 1, arrived.querySelectorAll(".ui-col .ui-msg").length);
}
{
  const refused = `Couldn't post to #review. The broker refused it: <img src=x onerror=alert(1)>. Your message is still here.`;
  const c = centre({ drafts: { [composeKey(REVIEW)]: draftOf("Approved. Run it.", { refused }) } });
  const k = card(c);
  ok("3.15 refused: the draft is in the box, the card is ringed, and Try again is the row",
    (k.querySelector("textarea") as HTMLTextAreaElement | null)?.value === "Approved. Run it." && k.classList.contains("ui-composer-err")
      && [...k.querySelectorAll(".ui-crow > button")].map((b) => textOf(b)).join() === "Try again", k.outerHTML);
  ok("3.16 the refusal is the note, as plain text: the server's markup is shown, never built",
    textOf(note(c)) === refused && note(c).querySelector("img") === null && note(c).getAttribute("role") === "alert" && note(c).classList.contains("ui-cnote-err"), note(c).outerHTML);
}
{
  /** The dock's children: the card with how many rows it has and what the last one is, then the note. */
  const shape = (c: Element) =>
    [...dockOf(c).children].map((x) =>
      x.classList.contains("ui-composer") ? ["card", x.children.length, x.lastElementChild?.className] : x.classList.contains("ui-cnote") ? ["note"] : [x.className]);
  const states = {
    live: centre({}),
    off: centre({ post: CREDS_OFF }),
    offSignIn: centre({ post: USER_OFF }),
    sending: centre({ drafts: { [composeKey(REVIEW)]: draftOf("", { outgoing: [{ seq: 1, text: "x", ts: 1 }] }) } }),
    refused: centre({ drafts: { [composeKey(REVIEW)]: draftOf("x", { refused: "Couldn't post to #review. x. Your message is still here." }) } }),
  };
  same("3.17 ONE DOCK HEIGHT: live, off (with and without a note), sending and refused each draw the same two elements, the card with its two rows and the note",
    Object.fromEntries(Object.entries(states).map(([k, c]) => [k, shape(c)])),
    Object.fromEntries(Object.keys(states).map((k) => [k, [["card", 2, "ui-crow"], ["note"]]])));
}
{
  const c = centre({}, rv2Route);
  const k = card(c);
  same("3.18 a DM view posts to its agent: Message reviewer_2, to reviewer_2, with the orange dot",
    [(k.querySelector("textarea") as HTMLTextAreaElement | null)?.placeholder, textOf(k.querySelectorAll(".ui-pick")[1]), (k.querySelector(".ui-mode-dot") as HTMLElement | null)?.getAttribute("style")?.includes("var(--uni)")],
    ["Message reviewer_2", "to reviewer_2", true]);
  same("3.19 posting off there, the command is cotal send dm with the agent's id, which the CLI resolves exactly", textOf(card(centre({ post: CREDS_OFF }, rv2Route)).querySelector(".ui-cmd code")), 'cotal send dm local.rv2 "<text>"');
  ok("3.20 a conversation between two agents has no composer", centre({}, { view: "dm", peer: "local.rev", with: "local.rv2" }).querySelector(".ui-composer textarea") === null);
  const header = centre({ operatorId: OP, dms: [{ msg: msg("d1", OP, "hi", { to: "local.rv2" }), senderId: OP }] }, { view: "dm", peer: "local.rv2", with: OP }).querySelector("header") ?? none();
  ok("3.21 the conversation with the operator says operator (you) while the roster does not name it", textOf(header).includes("with operator (you)"), textOf(header));
  const both: Partial<DashboardState> = {
    operatorId: OP,
    roster: [...roster, operator],
    dms: [
      { msg: msg("o1", OP, "Can you run it?", { to: "local.rv2", ts: 1 }), senderId: OP },
      { msg: msg("a1", "local.rv2", "Newer, to david.", { to: "local.dav", ts: 2 }), senderId: "local.rv2" },
    ],
  };
  const one = centre(both, rv2Route);
  same("3.22 a route naming only the agent opens the operator's conversation with it, not the agent's newest with someone else",
    [[...one.querySelectorAll("header .ui-topic")].map((x) => textOf(x)).at(-1), [...one.querySelectorAll(".ui-scroll .ui-msg .ui-tx")].map((x) => textOf(x))],
    ["with operator", ["Can you run it?"]]);
  const needs = centre({ roster: [...waitingRv2, operator], operatorId: OP });
  same("3.23 the Needs card's Message carries the operator's id once known, so it opens that conversation",
    [...needs.querySelectorAll(".ui-needs a")].map((a) => a.getAttribute("href")), [formatRoute(messageRoute("local.rv2", OP))]);
  const pair = centre({ operatorId: OP }, { view: "dm", peer: "local.rev", with: "local.rv2" });
  const pairDock = dockOf(pair);
  const link = pairDock.querySelector("a");
  same("3.24 a conversation between two agents says so in the dock's place, same two elements, with Message for the operator's own conversation with the peer",
    [textOf(pairDock.querySelector(".ui-reason")), textOf(link), link?.getAttribute("href"), [...pairDock.children].map((x) => x.className), pairDock.querySelector(".ui-composer")?.children.length],
    ["This conversation is between two agents.", "Message reviewer", formatRoute(messageRoute("local.rev", OP)), ["ui-card ui-composer", "ui-cnote"], 2]);
  const evil = "x'; true; echo $(echo hi)";
  const tabStore = createStore<DashboardState>({ ...initialState, ...seed({ roster: [...roster, entry("local.evil", evil, "idle")] }) });
  const tab = parse(renderToString(createElement(AgentTab, { store: tabStore, id: "local.evil", channel: null, clock: () => 2 })));
  same("3.25 the Agent tab quotes a hostile agent name in its attach and stop commands",
    [...tab.querySelectorAll(".ui-cmd code")].map((x) => x.textContent), [`cotal attach --name ${shellArg(evil)}`, `cotal stop --name ${shellArg(evil)}`]);
}

// ── 4. Mounted: typing, sending, and the Message buttons ─────────────────────────────────────────
/** The shell, with its route held in state so a cell can follow a link the way the hash does. */
const rig = async (store: Store<DashboardState>, controller: Controller, start: Route) => {
  let go!: (r: Route) => void;
  function Nav() {
    const [route, setRoute] = useState<Route>(start);
    go = setRoute;
    return createElement(Shell, { store, controller, route, paneOpen: route.view === "channel", msgPerSecond: () => 0 });
  }
  const m = await mount(createElement(Nav));
  return { m, go: (r: Route) => m.run(() => go(r)) };
};
const quiet: Partial<Api> = { history: async () => [] };
/** Type into a React-controlled textarea: set the value through the prototype, then fire input. */
const type = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
  el.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
};
const key = (el: Element, k: string, shiftKey = false) =>
  el.dispatchEvent(new (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));
{
  localStorage.clear();
  const sent: string[] = [];
  const h = harness({ ...quiet, send: async (_t, text) => { sent.push(text); throw new SendRefused(502, BROKER); } });
  h.store.set(seed());
  const { m } = await rig(h.store, h.ctl, channelRoute);
  const box = () => m.container.querySelector(".ui-composer textarea") as HTMLTextAreaElement;
  await m.run(() => type(box(), "Approved. Run it on build-box."));
  ok("4.1 typing reaches the draft and the send button wakes", h.store.get().drafts[composeKey(REVIEW)]?.text === "Approved. Run it on build-box."
    && (m.container.querySelector(".ui-composer .ui-send") as HTMLButtonElement).disabled === false);
  await m.run(() => key(box(), "Enter", true));
  ok("4.2 Shift+Enter does not send", sent.length === 0, sent);
  await m.run(() => key(box(), "Enter"));
  await m.run(() => undefined);
  ok("4.3 Enter sends, and after a refusal the draft is still in the box with the broker's refusal under it",
    sent.join() === "Approved. Run it on build-box." && box().value === "Approved. Run it on build-box."
      && textOf(m.container.querySelector(".ui-cnote")) === `Couldn't post to #review. The broker refused it: ${BROKER}. Your message is still here.`,
    { sent, box: box().value, note: textOf(m.container.querySelector(".ui-cnote")) });
  await m.run(() => (m.container.querySelector(".ui-composer .ui-crow .ui-btn") as HTMLButtonElement).click());
  await m.run(() => undefined);
  ok("4.4 Try again sends the draft again", sent.length === 2 && sent[1] === "Approved. Run it on build-box.", sent);
  await m.unmount();
}
{
  localStorage.clear();
  const h = harness(quiet);
  h.store.set(seed({ roster: [...waitingRv2, operator], operatorId: OP }));
  const { m, go } = await rig(h.store, h.ctl, channelRoute);
  const link = [...m.container.querySelectorAll(".ui-needs a")].find((a) => textOf(a) === "Message reviewer_2") as HTMLAnchorElement | undefined;
  await m.run(() => link?.click());
  await go(parseRoute(link?.getAttribute("href") ?? "", "/"));
  const focused = document.activeElement as HTMLTextAreaElement | null;
  ok("4.5 the Needs card's Message opens the DM view with its composer focused",
    m.container.querySelector('section.ui-view[data-view="dm"]') !== null && focused?.tagName === "TEXTAREA" && focused.placeholder === "Message reviewer_2",
    { view: m.container.querySelector("section.ui-view")?.getAttribute("data-view"), focused: focused?.outerHTML });
  await m.unmount();
}
{
  localStorage.clear();
  const h = harness(quiet);
  h.store.set(seed({ roster: [...waitingRv2, operator], operatorId: OP }));
  const { m, go } = await rig(h.store, h.ctl, channelRoute);
  const view = [...m.container.querySelectorAll(".ui-needs button")].find((b) => textOf(b) === "View agent") as HTMLButtonElement | undefined;
  await m.run(() => view?.click());
  const link = [...m.container.querySelectorAll(".ui-pane a")].find((a) => textOf(a) === "Message") as HTMLAnchorElement | undefined;
  await m.run(() => link?.click());
  await go(parseRoute(link?.getAttribute("href") ?? "", "/"));
  const focused = document.activeElement as HTMLTextAreaElement | null;
  ok("4.6 the Agent tab's Message opens the operator's conversation with the agent, with its composer focused",
    link?.getAttribute("href") === formatRoute(messageRoute("local.rv2", OP)) && m.container.querySelector('section.ui-view[data-view="dm"]') !== null && focused?.tagName === "TEXTAREA" && focused.placeholder === "Message reviewer_2",
    { link: link?.outerHTML, focused: focused?.outerHTML });
  await m.unmount();
}
{
  // A request the off composer cannot honour is still spent, so a later composer does not jump to it.
  const offStore = createStore<DashboardState>({ ...initialState, ...seed({ post: CREDS_OFF }) });
  const liveStore = createStore<DashboardState>({ ...initialState, ...seed() });
  const h = harness({});
  const off = await mount(createElement(Composer, { store: offStore, target: RV2, where: "reviewer_2", to: "to reviewer_2" }));
  await off.run(() => focusComposer(RV2));
  await off.unmount();
  const live = await mount(createElement(Compose.Provider, { value: h.ctl }, createElement(Composer, { store: liveStore, target: RV2, where: "reviewer_2", to: "to reviewer_2" })));
  ok("4.7 a focus request is spent by the composer that takes it, even one that cannot post, so a later visit does not take the focus",
    (document.activeElement as HTMLElement | null)?.tagName !== "TEXTAREA", (document.activeElement as HTMLElement | null)?.outerHTML);
  await live.unmount();
}
{
  const copied: string[] = [];
  Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText: async (t: string) => void copied.push(t) }, configurable: true });
  const h = harness(quiet);
  h.store.set(seed({ roster: waitingRv2, post: CREDS_OFF }));
  const { m } = await rig(h.store, h.ctl, channelRoute);
  const buttons = [...m.container.querySelectorAll(".ui-needs .ui-btns > *")].map((b) => [b.tagName, textOf(b)]);
  const copy = [...m.container.querySelectorAll(".ui-needs button")].find((b) => textOf(b) === "Copy command") as HTMLButtonElement | undefined;
  await m.run(() => copy?.click());
  same("4.8 posting off, the Needs card offers Copy command in Message's place, and it copies cotal send dm with the agent's id",
    [buttons, copied], [[["BUTTON", "View agent"], ["BUTTON", "Copy command"]], ['cotal send dm local.rv2 "<text>"']]);
  await m.unmount();
}

// ── 5. The sidebar footer ────────────────────────────────────────────────────────────────────────
{
  const foot = (patch: Partial<DashboardState>) => parse(renderShell(seed(patch), channelRoute, true)).querySelector(".ui-side-foot .ui-who span") ?? none();
  const before = foot({ operatorId: OP });
  same("5.1 a dashboard that posts reads Not on the roster until the operator's id is on it, with the participant line on hover",
    [textOf(before), before.getAttribute("title")], ["Not on the roster", "You'll show on the roster as operator when you post. Replies come to your DMs."]);
  const after = foot({ operatorId: OP, roster: [...roster, operator] });
  same("5.2 then On the roster, with its reason on hover",
    [textOf(after), after.getAttribute("title")], ["On the roster", "You show on the roster as operator once you post, so agents can reply to you."]);
  const off = foot({ post: CREDS_OFF });
  same("5.3 posting off reads Read only, with the full reason on hover", [textOf(off), off.getAttribute("title")], ["Read only", POST_OFF_CREDS]);
  const rows = parse(renderShell(seed({ operatorId: OP, dms: [{ msg: msg("d1", OP, "hi", { to: "local.rv2" }), senderId: OP }] }), channelRoute, true));
  ok("5.4 a conversation with the operator reads operator (you) in the sidebar while the roster does not name it",
    [...rows.querySelectorAll(".ui-side-scroll .ui-row-lbl")].some((x) => textOf(x) === "operator (you), reviewer_2"),
    [...rows.querySelectorAll(".ui-side-scroll .ui-row-lbl")].map((x) => textOf(x)));
  const who = parse(renderShell(seed({ post: CREDS_OFF }), channelRoute, true)).querySelector(".ui-side-foot .ui-who") ?? none();
  const lineEl = who.querySelector("span[aria-describedby]");
  const why = lineEl ? who.querySelector(`#${lineEl.getAttribute("aria-describedby")}`) : null;
  same("5.5 the footer line takes the keyboard focus and carries its reason as its accessible description, not on hover alone",
    [textOf(lineEl), lineEl?.getAttribute("tabindex"), textOf(why)], ["Read only", "0", POST_OFF_CREDS]);
}

// ── 6. Learning the operator's id after the page loaded ──────────────────────────────────────────
// An open mesh's /api/meta names the operator only once its poster has joined, so a page that read it
// before the first post (or a second tab) has to learn the id when the operator's card arrives.
const OP_META = { space: "main", pid: 1, post: PARTICIPANT, operatorId: OP };
{
  localStorage.clear();
  const h = harness({ ...quiet, meta: async () => OP_META });
  h.store.set(seed({ operatorId: null }));
  const opDm: Route = { view: "dm", peer: "local.rv2", with: OP };
  const { m } = await rig(h.store, h.ctl, opDm);
  const footer = () => textOf(m.container.querySelector(".ui-side-foot .ui-who span"));
  const dock = () => [textOf(m.container.querySelector(".ui-dock .ui-reason")), (m.container.querySelector(".ui-dock textarea") as HTMLTextAreaElement | null)?.placeholder ?? null];
  const before = [footer(), dock()];
  await m.run(() => h.ctl.onRoster([...roster, operator]));
  await m.run(() => undefined);
  same("6.1 a page that loaded before the operator joined learns its id once the operator's card arrives and /api/meta reports it: the footer turns to On the roster, and the operator's DM with an agent shows the composer, not the between-two-agents line",
    [before, [footer(), dock()], h.store.get().operatorId],
    [["Not on the roster", ["This conversation is between two agents.", null]], ["On the roster", ["", "Message reviewer_2"]], OP]);
  await m.unmount();
}
{
  let reads = 0;
  const h = harness({ meta: async () => { reads++; return OP_META; } });
  h.ctl.onRoster(roster);
  await new Promise((r) => setTimeout(r, 0));
  const withoutCard = reads;
  h.ctl.onRoster([...roster, operator]);
  await new Promise((r) => setTimeout(r, 0));
  h.ctl.onRoster([...roster, operator]);
  await new Promise((r) => setTimeout(r, 0));
  same("6.2 /api/meta is read again only once the operator's card is on the roster, and not again once the id is known",
    [withoutCard, reads, h.store.get().operatorId], [0, 1, OP]);
}
{
  const gates: ReturnType<typeof gate<Meta>>[] = [];
  const h = harness({ meta: () => { const g = gate<Meta>(); gates.push(g); return g.promise; } });
  const noId: Meta = { space: "main", pid: 1, post: PARTICIPANT };
  h.ctl.onRoster([...roster, operator]);
  h.ctl.onRoster([...roster, operator]);
  const inFlight = gates.length;
  gates[0].resolve(noId);
  await new Promise((r) => setTimeout(r, 0));
  const followUp = gates.length;
  gates[1]?.resolve(noId);
  await new Promise((r) => setTimeout(r, 0));
  same("6.3 THE RE-READ CANNOT LOOP: one is in flight at most, a roster that came during it is read for once after it, and a meta that still has no id starts no further read",
    [inFlight, followUp, gates.length, h.store.get().operatorId], [1, 2, 2, null]);
}
{
  const h = harness({ ...bootReads, meta: async () => OP_META });
  h.store.set({ operatorId: "local.old" });
  await h.ctl.refresh();
  same("6.4 a meta that reports a different operator id replaces the stored one, since a restarted server posts under a new id", h.store.get().operatorId, OP);
}
{
  const h = harness({ ...bootReads, send: async () => answer("m-10") });
  await h.ctl.send(REVIEW, "x");
  await h.ctl.refresh();
  same("6.5 a meta with no operator id keeps the one a post's answer gave", h.store.get().operatorId, OP);
}

await closeDom();
console.log(`compose: ${n} checks passed`);
