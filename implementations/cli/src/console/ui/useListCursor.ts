import { useState } from "react";

/** A bounded row cursor that starts at `start`. Tail-following lists start at the end and stay there
 *  until the user moves away. */
export function useListCursor(length: number, { followTail = false, start = 0 }: { followTail?: boolean; start?: number } = {}) {
  const lastIndex = Math.max(0, length - 1);
  const clamp = (index: number) => Math.max(0, Math.min(index, lastIndex));
  const [cursor, setCursor] = useState(() => ({ length, index: followTail ? lastIndex : clamp(start) }));
  let index = clamp(cursor.index);

  // Adjust before committing children or input handlers, so a shrink cannot leave hidden state
  // beyond the visible selection or race an effect against a key press.
  if (cursor.length !== length) {
    if (followTail && cursor.index >= cursor.length - 1) index = lastIndex;
    setCursor({ length, index });
  }

  const move = (delta: number) => setCursor((previous) => ({ length, index: clamp(previous.index + delta) }));
  return {
    index,
    up: () => move(-1),
    down: () => move(1),
    first: () => setCursor({ length, index: 0 }),
    last: () => setCursor({ length, index: lastIndex }),
  };
}
