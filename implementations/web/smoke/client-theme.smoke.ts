/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** The theme choice survives a browser that blocks storage: reading falls back to "system", writing
 *  does nothing, and neither throws. With working storage a choice round-trips, and applying one
 *  sets data-theme on the root element, which tokens.css reads. */
import { strict as assert } from "node:assert";
import { applyTheme, readTheme, writeTheme } from "../client/src/theme.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};
const stub = (name: "localStorage" | "document", value: unknown) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
/** The result of a call, or the error it threw, so a failing cell names itself instead of crashing the run. */
const attempt = <T>(fn: () => T): { value?: T; threw?: string } => {
  try { return { value: fn() }; } catch (e) { return { threw: String(e) }; }
};

const blocked = {
  getItem: () => { throw new Error("SecurityError: storage is blocked"); },
  setItem: () => { throw new Error("SecurityError: storage is blocked"); },
};
stub("localStorage", blocked);
const read = attempt(readTheme);
ok("readTheme returns system when storage throws", read.threw === undefined && read.value === "system", read);
const write = attempt(() => writeTheme("dark"));
ok("writeTheme does not throw when storage throws", write.threw === undefined, write);

const data = new Map<string, string>();
stub("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
ok("a fresh browser reads system", readTheme() === "system");
writeTheme("dark");
ok("a saved dark choice reads back as dark", readTheme() === "dark");
writeTheme("light");
ok("a saved light choice reads back as light", readTheme() === "light");
data.set("cotal.theme", "sepia");
ok("a saved value that is not a theme reads as system", readTheme() === "system");

const root = { dataset: {} as Record<string, string> };
stub("document", { documentElement: root });
applyTheme("dark");
ok("applyTheme sets data-theme on the root element", root.dataset.theme === "dark", root.dataset);
applyTheme("system");
ok("applyTheme passes system through for tokens.css to follow the OS", root.dataset.theme === "system", root.dataset);
console.log(`client-theme: ${n} checks passed`);
