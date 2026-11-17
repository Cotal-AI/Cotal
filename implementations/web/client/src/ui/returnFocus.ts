import { useRef } from "react";

/** The parts of the page's document and of an element the focus return uses. Spelled out rather than
 *  taken from the DOM lib, because the suites typecheck the components that render on the server with
 *  no DOM lib. */
type Focusable = { focus(): void };
type Page = { document: { activeElement: unknown } };

/** The focus props for a shadcn SheetContent that opens with no SheetTrigger. Radix puts focus back
 *  on a sheet's trigger when it closes, and a sheet with none would leave focus on the page's body, so
 *  these note what held focus when the sheet opened and put focus back there when it closes. */
export function useReturnFocus() {
  const before = useRef<Focusable | null>(null);
  return {
    onOpenAutoFocus: () => {
      before.current = (globalThis as unknown as Page).document.activeElement as Focusable | null;
    },
    onCloseAutoFocus: (e: { preventDefault(): void }) => {
      e.preventDefault();
      before.current?.focus();
      before.current = null;
    },
  };
}
