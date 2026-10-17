import { Tick02Icon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { mark } from "../art/index.ts";
import { Icon } from "../icons/Icon.tsx";
import { pageDocument } from "./focusTrap.tsx";
import { RailIcon, type RailIconName } from "../icons/rail.js";
import { formatRoute, type Route } from "../lib/route.js";
import type { Theme } from "../lib/theme.js";

interface View {
  label: string;
  icon: RailIconName;
  view: Route["view"];
}

/** The rail's views, top to bottom, with the names the mock gives them. There is no Workflow runs
 *  item and no Needs you item: that view is reached from the sidebar. */
const VIEWS: View[] = [
  { label: "Activity", icon: "activity", view: "activity" },
  { label: "Channels", icon: "hash", view: "channel" },
  { label: "Direct messages", icon: "dm", view: "dm" },
  { label: "Agents", icon: "agents", view: "agents" },
  { label: "Topology", icon: "graph", view: "topology" },
];

/** Where the Channels and Direct messages items land off their own views: the place of that kind
 *  the reader last visited, or the first there is, or null when there is none yet. A conversation
 *  names both parties, so the item opens the conversation it stands for. */
export interface Places {
  channel: string | null;
  dm: { peer: string; with: string } | null;
}

/** Why an item that leads nowhere yet is disabled: the empty state the reader would find there. */
export const EMPTY_TITLE: Partial<Record<Route["view"], string>> = {
  channel: "No channels yet. One appears with its first message.",
  dm: "No direct messages yet.",
};

/** Where an item leads, or null when it leads nowhere yet. On its own view an item keeps the current
 *  route, so a host-grouped Agents view or a two-party conversation is not reset by clicking it. A
 *  channel or a conversation to land on has to exist, and the shell says which. */
export function leadsTo(view: Route["view"], route: Route, places: Places): Route | null {
  if (route.view === view) return route;
  switch (view) {
    case "channel":
      return places.channel === null ? null : { view, channel: places.channel };
    case "dm":
      return places.dm === null ? null : { view, ...places.dm };
    case "agents":
      return { view, group: "status" };
    case "activity":
    case "topology":
    case "needs":
      return { view };
    case "agent":
      // No item stands for one agent's session; the Agents item is current there.
      return null;
  }
}

/** The theme choices the Settings menu offers, in the order it lists them. */
const CHOICES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** The parts of an element the menu's keys and its outside click use. Spelled out rather than taken
 *  from the DOM lib, because the suites typecheck the components that render on the server with no
 *  DOM lib. */
type Focusable = { focus(): void };
type Box = { contains(other: unknown): boolean; querySelectorAll(selector: string): ArrayLike<Focusable> };

/** The Settings item at the foot of the rail and the menu it opens: the theme, System, Light or Dark,
 *  as radio items with the chosen one checked by a tick as well as by state. Picking one applies it
 *  and closes the menu. Up and Down (wrapping), Home and End move between the items; Escape closes
 *  the menu and puts focus back on Settings; a click outside closes it. With no `onTheme` the item is
 *  disabled. */
function Settings({ theme, onTheme }: { theme?: Theme; onTheme?: (t: Theme) => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = () => Array.from((menu.current as unknown as Box | null)?.querySelectorAll("[role=menuitemradio]") ?? []);
  // Focus moves once, when the menu opens, so the checked item is read at that moment only.
  useEffect(() => {
    if (!open) return;
    const checked = CHOICES.findIndex((t) => t.value === theme);
    items()[Math.max(checked, 0)]?.focus();
    const doc = pageDocument();
    const outside = (e: { target: unknown }) => {
      const inside = [menu.current, button.current].some((el) => (el as unknown as Box | null)?.contains(e.target));
      if (!inside) setOpen(false);
    };
    doc.addEventListener("pointerdown", outside);
    return () => doc.removeEventListener("pointerdown", outside);
  }, [open]);
  const close = () => {
    setOpen(false);
    (button.current as unknown as Focusable | null)?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      close();
      return;
    }
    const list = items();
    const at = list.findIndex((el) => el === pageDocument().activeElement);
    const step: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 };
    if (!Object.hasOwn(step, e.key) || list.length === 0) return;
    e.preventDefault();
    list[(step[e.key] + list.length) % list.length]?.focus();
  };
  return (
    <div className="ui-rail-set">
      <button
        ref={button}
        type="button"
        className="ui-rail-btn"
        aria-label="Settings"
        title="Settings"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!onTheme}
        onClick={() => setOpen((o) => !o)}
      >
        <RailIcon name="gear" size={22} />
      </button>
      {open && onTheme && (
        <div ref={menu} className="ui-card ui-menu" role="menu" aria-label="Theme" onKeyDown={onKey}>
          <div className="ui-menu-h" aria-hidden="true">Theme</div>
          {CHOICES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="menuitemradio"
              aria-checked={theme === t.value}
              tabIndex={-1}
              onClick={() => {
                onTheme(t.value);
                close();
              }}
            >
              {theme === t.value ? <Icon icon={Tick02Icon} size={16} className="ui-ic ui-ic16" /> : <span className="ui-menu-gap" />}
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The view rail down the left edge, under the Cotal mark. `places` says where Channels and Direct
 *  messages lead when the route is not already on them. Agents is current on an agent's session too. An item that leads nowhere yet is a button
 *  marked disabled, which keyboard and screen readers still reach, titled with the empty state it
 *  would show. Settings opens the theme menu when `onTheme` is given and is disabled until then. The
 *  mark is drawn in `currentColor`, so the stylesheet's `--mark` token gives it the brand navy by day
 *  and cream at night. */
export function Rail({ route, places, theme, onTheme }: { route: Route; places: Places; theme?: Theme; onTheme?: (t: Theme) => void }) {
  return (
    <nav className="ui-rail" aria-label="Views">
      <span className="ui-rail-mark" dangerouslySetInnerHTML={{ __html: mark("currentColor") }} />
      {VIEWS.map(({ label, icon, view }) => {
        const to = leadsTo(view, route, places);
        const here = route.view === view || (view === "agents" && route.view === "agent");
        const Item = to ? "a" : "button";
        return (
          <Item
            key={view}
            className="ui-rail-btn"
            href={to ? formatRoute(to) : undefined}
            type={to ? undefined : "button"}
            aria-disabled={to ? undefined : true}
            aria-current={here ? "page" : undefined}
            aria-label={label}
            title={to ? label : (EMPTY_TITLE[view] ?? label)}
          >
            <RailIcon name={icon} size={22} />
          </Item>
        );
      })}
      <div className="ui-grow" />
      <Settings theme={theme} onTheme={onTheme} />
    </nav>
  );
}
