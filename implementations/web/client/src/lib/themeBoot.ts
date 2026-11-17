// The theme boot: what the page runs in its head, before the stylesheet draws anything, to put the
// saved theme on the root element. The build writes this function's own text into the classic
// script `theme-boot.js` (vite.config.ts), so the body uses nothing from outside itself.

/** Puts the saved theme on `root` as shadcn's class, `light` or `dark`: the choice saved under
 *  `cotal.theme` when it is light or dark, and the OS setting (`prefersDark`) when it is system,
 *  nothing valid is saved, or storage is blocked. `storage` is a function because in a browser that
 *  blocks storage even reading `localStorage` throws. The key and the choices restate the
 *  `storageKey` App gives `../ui/theme-provider.tsx` and `THEMES`: smoke:web-client-build drives this
 *  with every choice in `THEMES`, and smoke:web-layout pins the key the Settings menu saves under. */
export function bootTheme(storage: () => { getItem(key: string): string | null }, root: { classList: { add(token: string): void } }, prefersDark: () => boolean): void {
  let theme = "system";
  try {
    const saved = storage().getItem("cotal.theme");
    if (saved === "light" || saved === "dark") theme = saved;
  } catch {
    // Blocked storage is a browser setting: the page follows the system.
  }
  root.classList.add(theme === "system" ? (prefersDark() ? "dark" : "light") : theme);
}
