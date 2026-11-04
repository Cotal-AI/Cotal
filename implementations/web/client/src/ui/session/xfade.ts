import { useState } from "react";

/** The class that cross-fades a text in place (`ui-xfade`, agents mock G), or undefined. A part keys
 *  the element holding `text` by it, so a new text mounts afresh and fades in. Nothing fades until the
 *  text has changed once since the part mounted: the first paint, a history read and Load earlier
 *  draw it in place. */
export function useXfade(text: string): string | undefined {
  const [first] = useState(text);
  const [moved, setMoved] = useState(false);
  // Set during render, so the changed text never draws a frame without its fade.
  if (!moved && text !== first) setMoved(true);
  return moved || text !== first ? "ui-xfade" : undefined;
}
