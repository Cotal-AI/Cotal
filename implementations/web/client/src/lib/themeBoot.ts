// The theme boot: what the page runs in its head, before the stylesheet draws anything, to put the
// saved theme on the root element. The build writes this function's own text into the classic
// script `theme-boot.js` (vite.config.ts), so the body uses nothing from outside itself.

/** Puts the saved theme on `root` as `data-theme`: the choice saved under `cotal.theme` when it is
 *  one of the three, and "system" when nothing valid is saved or storage is blocked. `storage` is a
 *  function because in a browser that blocks storage even reading `localStorage` throws. The key and
 *  the choices restate `../theme.ts`: smoke:web-client-build drives this with every choice in
 *  `THEMES`, and smoke:web-layout pins the key the Settings menu saves under. */
export function bootTheme(storage: () => { getItem(key: string): string | null }, root: { setAttribute(name: string, value: string): void }): void {
  let theme = "system";
  try {
    const saved = storage().getItem("cotal.theme");
    if (saved === "light" || saved === "dark" || saved === "system") theme = saved;
  } catch {
    // Blocked storage is a browser setting: the page follows the system.
  }
  root.setAttribute("data-theme", theme);
}
