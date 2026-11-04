import { useEffect, useRef, type ReactNode } from "react";

/** The parts of the page's document and elements the focus code uses. Spelled out rather than taken
 *  from the DOM lib, because the suites typecheck the components that render on the server with no
 *  DOM lib. */
type El = { focus(): void; contains(other: unknown): boolean; querySelectorAll(selector: string): ArrayLike<El>; hasAttribute(name: string): boolean; tabIndex: number };
type Key = { key: string; shiftKey: boolean; preventDefault(): void };
type Doc = {
  activeElement: unknown;
  addEventListener(type: string, listener: (e: Key & { target: unknown }) => void): void;
  removeEventListener(type: string, listener: (e: Key & { target: unknown }) => void): void;
};

/** The page's document. Called only from effects and handlers, which never run on the server. */
export const pageDocument = (): Doc => (globalThis as unknown as { document: Doc }).document;

/** What can take focus by Tab inside a box. */
const TABBABLE = "a[href], button, input, select, textarea, [tabindex]";

/** Holds keyboard focus inside its children while it is drawn, as a modal sheet or a full-screen
 *  panel needs: focus moves to the first thing that takes it when the trap appears, Tab and Shift Tab
 *  wrap at the ends, Escape calls `onEscape`, and when the trap goes focus returns to where it was
 *  before. The wrapper draws no box of its own (`display: contents`), so the children lay out as if
 *  it were not there. */
export function FocusTrap({ onEscape, children }: { onEscape: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    const el = box.current as unknown as El | null;
    if (!el) return;
    const doc = pageDocument();
    const before = doc.activeElement as El | null;
    const tabbable = () => Array.from(el.querySelectorAll(TABBABLE)).filter((t) => !t.hasAttribute("disabled") && t.tabIndex >= 0);
    tabbable()[0]?.focus();
    const onKey = (e: Key) => {
      if (e.key === "Escape") {
        e.preventDefault();
        escape.current();
        return;
      }
      if (e.key !== "Tab") return;
      const list = tabbable();
      if (list.length === 0) return e.preventDefault();
      const first = list[0];
      const last = list[list.length - 1];
      const at = doc.activeElement;
      if (!el.contains(at) || (e.shiftKey && at === first) || (!e.shiftKey && at === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    doc.addEventListener("keydown", onKey);
    return () => {
      doc.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, []);
  return <div ref={box} style={{ display: "contents" }}>{children}</div>;
}
