export type Theme = "system" | "light" | "dark";

const KEY = "cotal.theme";
const THEMES: readonly Theme[] = ["system", "light", "dark"];

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
