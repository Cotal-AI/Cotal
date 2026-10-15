import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { useLayoutEffect, useState } from "react";
import { Icon } from "../icons/Icon.tsx";
import { formatRoute } from "../lib/route.js";
import type { RosterRow } from "../lib/roster.js";
import { Avatar } from "./Avatar.tsx";
import { clock } from "./MessageRow.tsx";

/** Where this browser keeps its dismissals: a JSON list of `needsKey` values. */
const KEY = "cotal.needs.dismissed";
/** The most dismissals kept. Older ones belong to statuses long since changed. */
const KEPT = 100;
const DISMISS = "Dismiss until the status changes";

/** The key a dismissal is stored under: the agent and the moment its status began. A status change
 *  moves `statusSince`, so the same agent waiting again is a new key and its card comes back. */
export const needsKey = (row: Pick<RosterRow, "id" | "statusSince">): string => `${row.id} ${row.statusSince ?? ""}`;

/** Every dismissal made since the page loaded. Storage may be blocked, so this is what keeps a
 *  dismissal for the life of the page, across view switches that unmount the card. */
const thisPage = new Set<string>();

/** The saved dismissals plus this page's own, the saved ones read as none when storage is blocked or
 *  holds something else. */
function readDismissed(): string[] {
  let saved: string[] = [];
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "[]");
    if (Array.isArray(raw)) saved = raw.filter((k): k is string => typeof k === "string");
  } catch {
    // Blocked storage is a browser setting, not a fault: this page's own dismissals still count.
  }
  return [...new Set([...saved, ...thisPage])];
}

/** Save the dismissals. When the browser blocks storage nothing is saved, and a dismissal then lasts
 *  until the page closes, held by `thisPage`. */
function writeDismissed(keys: string[]): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(keys.slice(-KEPT)));
  } catch {
    // Blocked storage is a browser setting, not a fault.
  }
}

/** This browser's Needs card dismissals and the way to add one. Nothing is sent to the mesh. The
 *  saved ones are read in a layout effect, before the first paint, so a server render never touches
 *  storage and the browser never shows a dismissed card for a frame. */
export function useDismissed(): [ReadonlySet<string>, (key: string) => void] {
  const [keys, setKeys] = useState<string[]>([]);
  useLayoutEffect(() => setKeys(readDismissed()), []);
  const dismiss = (key: string) => {
    thisPage.add(key);
    const next = [...keys.filter((k) => k !== key), key];
    setKeys(next);
    writeDismissed(next);
  };
  return [new Set(keys), dismiss];
}

/** What the card says under the name: the agent's own activity text, then when it reported. Without
 *  a `statusSince` there is no time to give, and none is made up. */
function detail(row: RosterRow): string {
  const at = typeof row.statusSince === "number" && Number.isFinite(row.statusSince) ? `Reported ${clock(new Date(row.statusSince))}` : undefined;
  const parts = [row.activity?.trim().replace(/\.$/, ""), at].filter((p): p is string => Boolean(p));
  return parts.length ? `${parts.join(". ")}.` : "";
}

/** The card for an agent whose status is waiting (mock section D, the dock). "Waiting" is all
 *  presence says, so the card names no one the agent waits for and no duration; "Reported" dates the
 *  report. View agent opens the Agent tab when the shell has one (`onViewAgent`) and is disabled
 *  until then. Message opens the DM view, and dismiss hides the card until the status changes. */
export function NeedsCard({ row, onViewAgent, onDismiss }: { row: RosterRow; onViewAgent?: (id: string) => void; onDismiss: () => void }) {
  return (
    <div className="ui-card ui-needs">
      <Avatar vendor={row.harness} status={row.status} size={34} />
      <div style={{ minWidth: 0 }}>
        <b>{`${row.name} is waiting`}</b>
        <span className="ui-nd">{detail(row)}</span>
      </div>
      <div className="ui-btns">
        <button type="button" className="ui-btn" disabled={!onViewAgent} onClick={() => onViewAgent?.(row.id)}>View agent</button>
        <a className="ui-btn ui-btn-primary" href={formatRoute({ view: "dm", peer: row.id })}>{`Message ${row.name}`}</a>
      </div>
      <button type="button" className="ui-x" title={DISMISS} aria-label={DISMISS} onClick={onDismiss}>
        <Icon icon={Cancel01Icon} size={16} className="ui-ic ui-ic16" />
      </button>
    </div>
  );
}
