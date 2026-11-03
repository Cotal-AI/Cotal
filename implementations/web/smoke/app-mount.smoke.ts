/** The wiring in `App`, mounted with `react-dom/client` in jsdom: the route in the address reaches
 *  the controller (a channel route opens that channel, any other route closes the open one), a hash
 *  change re-routes, and unmounting stops the dashboard. The dashboard is a fake that records what
 *  it is asked; the address is a fake host whose hash the suite sets and whose hashchange it fires.
 *  `app-shell.smoke.ts` drives the same pieces one at a time; this proves `App` wires them. */
import { closeDom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { createElement } from "react";
import { App } from "../client/src/App.tsx";
import type { RouteHost } from "../client/src/routeWatch.js";
import type { Controller } from "../client/src/state/controller.js";
import { mount } from "./mount.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};

/** A dashboard that records every `open` and every `stop`, and an address that holds `hash`. */
const rig = (hash: string) => {
  const opened: (string | null)[] = [];
  let stops = 0;
  const controller = { open: async (c: string | null) => void opened.push(c) } as unknown as Controller;
  const start = () => ({ controller, stop: () => void stops++ });
  const listeners = new Set<() => void>();
  const host: RouteHost = {
    location: { hash, pathname: "/" },
    history: { replaceState: () => undefined },
    addEventListener: (_type, l) => void listeners.add(l),
    removeEventListener: (_type, l) => void listeners.delete(l),
  };
  return { opened, stops: () => stops, start, host, listeners, go: (h: string) => { host.location.hash = h; listeners.forEach((l) => l()); } };
};
/** Which rail item says it is the current page. */
const current = (root: HTMLElement) => root.querySelector('.ui-rail [aria-current="page"]')?.getAttribute("aria-label");

{
  const r = rig("#/channel/review");
  const m = await mount(createElement(App, { host: r.host, start: r.start }));
  ok("1.1 a channel route opens that channel", r.opened.at(-1) === "review" && r.opened.includes("review"), r.opened);
  ok("1.2 and the rail marks Channels", current(m.container) === "Channels", current(m.container));
  await m.unmount();
}
{
  const r = rig("#/agents");
  const m = await mount(createElement(App, { host: r.host, start: r.start }));
  ok("1.3 any other route opens nothing, closing what was open", r.opened.length > 0 && r.opened.every((c) => c === null), r.opened);
  await m.unmount();
}
{
  const r = rig("#/activity");
  const m = await mount(createElement(App, { host: r.host, start: r.start }));
  await m.run(() => r.go("#/channel/general"));
  ok("1.4 a hashchange re-routes: the new channel is opened and the rail follows",
    r.opened.at(-1) === "general" && current(m.container) === "Channels", { opened: r.opened, current: current(m.container) });
  await m.run(() => r.go("#/topology"));
  ok("1.5 and leaving the channel by the address closes it", r.opened.at(-1) === null && current(m.container) === "Topology", r.opened);
  ok("1.6 CONTROL: the dashboard has not been stopped while mounted", r.stops() === 0, r.stops());
  await m.unmount();
  ok("1.7 unmounting stops the dashboard", r.stops() === 1, r.stops());
  ok("1.8 and stops following the address", r.listeners.size === 0, r.listeners.size);
}

await closeDom();
console.log(`app-mount: ${n} checks passed`);
