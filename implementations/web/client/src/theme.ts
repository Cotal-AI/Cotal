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

/** Puts the saved choice on the root element and returns it. The entry module calls it at its top
 *  level, before React mounts, so a reader who chose the other palette never sees a frame of the
 *  system's first. It is code in the bundle and not an inline script, so the page can keep a
 *  `script-src 'self'` policy. Browser only. */
export function initTheme(): Theme {
  const t = readTheme();
  applyTheme(t);
  return t;
}

/** The theme as React state for the Settings menu: the choice on the root element now, and the way to
 *  change it, which applies it at once and saves it for the next load. Browser only. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const choose = (t: Theme) => {
    applyTheme(t);
    writeTheme(t);
    setTheme(t);
  };
  return [theme, choose];
}
