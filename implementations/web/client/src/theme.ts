import { useState } from "react";
import { THEMES, type Theme } from "./lib/theme.js";

export type { Theme };

const KEY = "cotal.theme";

/** The saved choice, or "system" when nothing valid is saved or the browser blocks storage. Browser only. */
export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    return THEMES.find((t) => t === saved) ?? "system";
  } catch {
    return "system";
  }
}

/** Saves the choice for the next load. When the browser blocks storage nothing is saved. Browser only. */
export function writeTheme(t: Theme): void {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // Blocked storage is a browser setting, not a fault: the choice then lasts until the page closes.
  }
}

/** Puts the choice on the root element, where tokens.css reads it. Browser only. */
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}

/** The theme as React state for the Settings menu: the saved choice, and the way to change it, which
 *  applies it at once and saves it for the next load. The saved choice is on the root element before
 *  this runs: the build's `theme-boot.js` (`lib/themeBoot.ts`) puts it there ahead of the stylesheet.
 *  Browser only. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const choose = (t: Theme) => {
    applyTheme(t);
    writeTheme(t);
    setTheme(t);
  };
  return [theme, choose];
}
