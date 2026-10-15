import { Delete02Icon } from "@hugeicons/core-free-icons";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "../../icons/Icon.tsx";
import type { Controller } from "../../state/controller.js";

/** The part of an element the focus trap uses. Spelled out rather than taken from the DOM lib,
 *  because the suites typecheck the components that render on the server with no DOM lib. */
type Focusable = { focus(): void };
type Box = { querySelectorAll(selector: string): ArrayLike<Focusable> };

/** What Tab moves between inside the dialog. A disabled button is skipped, as the browser skips it. */
const TABBABLE = "input, button:not([disabled])";

/** The type-the-name check before a channel is deleted (mock section B, before and after typing).
 *
 *  - The destructive button names the channel and stays disabled until the field holds the name
 *    exactly, so a wrong tab cannot delete the wrong channel.
 *  - The dialog keeps one size whatever is typed: the error has its own row, empty until a refusal.
 *  - Confirming calls `controller.deleteChannel`. A refusal keeps the dialog open and shows the
 *    server's error in it, as it came.
 *  - The field takes focus when the dialog opens, Tab stays inside it, and Escape closes it. A click
 *    on the scrim around it puts focus back on the field. The caller returns focus to what opened
 *    it, in `onClose`.
 *  - The scrim is fixed to the viewport, so it covers the whole page wherever the dialog is drawn. */
export function DeleteChannelDialog({ channel, space, controller, onClose }: {
  channel: string;
  space: string | null;
  controller: Controller | null;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const title = useId();
  const body = useId();
  useEffect(() => (field.current as unknown as Focusable | null)?.focus(), []);
  const matches = typed === channel;

  const confirm = async () => {
    if (!matches || controller === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await controller.deleteChannel(channel);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || box.current === null) return;
    const items = Array.from((box.current as unknown as Box).querySelectorAll(TABBABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const at = e.target as unknown;
    if (e.shiftKey && at === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="ui-scrim"
      onMouseDown={(e) => {
        // A click on the scrim would move focus to the page behind, where Escape no longer reaches
        // the dialog. It keeps focus in the dialog instead, on the field.
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        (field.current as unknown as Focusable | null)?.focus();
      }}
    >
      <div ref={box} className="ui-card ui-dialog" role="dialog" aria-modal="true" aria-labelledby={title} aria-describedby={body} onKeyDown={onKeyDown}>
        <h4 id={title}>{`Delete #${channel}?`}</h4>
        <p id={body}>{`This deletes every message in #${channel} for everyone${space ? ` on ${space}` : ""}. You can't undo it. If anyone posts to #${channel} again, it comes back empty.`}</p>
        <label>
          <span>Type <b style={{ color: "var(--ink)" }}>{channel}</b> to confirm</span>
          <input
            ref={field}
            className="ui-field"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped((e.target as unknown as { value: string }).value)}
          />
        </label>
        <span className="ui-dialog-err" role="alert">{error}</span>
        <div className="ui-btns">
          <button type="button" className="ui-btn" onClick={onClose}>Keep channel</button>
          <button type="button" className={matches ? "ui-btn ui-btn-danger-solid" : "ui-btn"} disabled={!matches || busy || controller === null} onClick={() => void confirm()}>
            <Icon icon={Delete02Icon} size={16} className="ui-ic ui-ic16" />
            {`Delete #${channel}`}
          </button>
        </div>
      </div>
    </div>
  );
}
