export type Theme = "system" | "light" | "dark";

const KEY = "cotal.theme";
const THEMES: readonly Theme[] = ["system", "light", "dark"];

/** The saved choice, or "system" when nothing valid is saved. Browser only: it reads localStorage. */
export function readTheme(): Theme {
  const saved = localStorage.getItem(KEY);
  return THEMES.find((t) => t === saved) ?? "system";
}

/** Saves the choice for the next load. Browser only. */
export function writeTheme(t: Theme): void {
  localStorage.setItem(KEY, t);
}

/** Puts the choice on the root element, where tokens.css reads it. Browser only. */
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}
