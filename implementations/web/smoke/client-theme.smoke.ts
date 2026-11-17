/** shadcn's ThemeProvider (`ui/theme-provider.tsx`) as the Settings menu uses it, mounted in jsdom
 *  with a `matchMedia` the suite controls: a choice made through `useTheme` is saved under the
 *  provider's `storageKey` and puts shadcn's class on the root element, the next load reads it back,
 *  System follows the OS setting as it changes, and a browser that blocks storage neither breaks the
 *  page nor keeps a choice. */
import { closeDom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { createElement } from "react";
import { ThemeProvider, useTheme } from "../client/src/ui/theme-provider.tsx";
import { mount } from "./mount.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};

const KEY = "cotal.theme";
const DARK = "(prefers-color-scheme: dark)";
let osDark = false;
const heard = new Set<() => void>();
(window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
  get matches() { return q === DARK && osDark; },
  media: q,
  addEventListener: (_t: string, l: () => void) => heard.add(l),
  removeEventListener: (_t: string, l: () => void) => heard.delete(l),
});
const root = document.documentElement;

let theme: ReturnType<typeof useTheme> | undefined;
const Probe = () => {
  theme = useTheme();
  return null;
};
const load = () => mount(createElement(ThemeProvider, { defaultTheme: "system", storageKey: KEY, children: createElement(Probe) }));

const fresh = await load();
ok("a fresh browser starts on System, the class following the OS setting", theme?.theme === "system" && root.className === "light", { theme: theme?.theme, cls: root.className });
await fresh.run(() => theme!.setTheme("dark"));
ok("choosing Dark saves it under the storage key and puts the dark class on the root element",
  localStorage.getItem(KEY) === "dark" && root.className === "dark", { saved: localStorage.getItem(KEY), cls: root.className });
await fresh.unmount();

const again = await load();
ok("the next load reads the saved choice back", theme?.theme === "dark" && root.className === "dark", { theme: theme?.theme, cls: root.className });
await again.run(() => theme!.setTheme("system"));
const follows: string[] = [];
for (const dark of [true, false]) {
  osDark = dark;
  await again.run(() => heard.forEach((l) => l()));
  follows.push(root.className);
}
ok("while System is chosen the class follows the OS setting as it changes", JSON.stringify(follows) === JSON.stringify(["dark", "light"]), follows);
await again.run(() => theme!.setTheme("light"));
ok("leaving System stops listening to the OS setting", heard.size === 0, heard.size);
await again.unmount();

localStorage.setItem(KEY, "sepia");
const junk = await load();
ok("a saved value that is not a theme loads as the default", theme?.theme === "system", theme?.theme);
await junk.unmount();

const real = localStorage;
Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("SecurityError: storage is blocked"); } });
let threw: unknown;
try {
  const blocked = await load();
  ok("with storage blocked the provider still loads, on the default", theme?.theme === "system", theme?.theme);
  await blocked.run(() => theme!.setTheme("dark"));
  ok("and a choice still applies for this page, with nothing saved", theme?.theme === "dark" && root.className === "dark", { theme: theme?.theme, cls: root.className });
  await blocked.unmount();
} catch (e) {
  threw = e;
}
Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: real });
ok("blocked storage throws nothing out of the provider", threw === undefined, String(threw));

console.log(`client-theme: ${n} checks passed`);
await closeDom();
