import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const panes: { querySelector: (sel: string) => { textContent: string; className: string } }[] = [];
function element() {
  const fields: Record<string, { textContent: string; className: string }> = {};
  const el = {
    className: "",
    innerHTML: "",
    style: {} as { display?: string },
    appendChild() {},
    remove() {},
    querySelector(sel: string) {
      fields[sel] ??= { textContent: "", className: "" };
      return fields[sel]!;
    },
  };
  panes.push(el);
  return el;
}
function Terminal(this: { loadAddon: () => void; open: () => void; onData: () => void; onResize: () => void; cols: number; rows: number; write: () => void; dispose: () => void }) {
  this.loadAddon = () => {};
  this.open = () => {};
  this.onData = () => {};
  this.onResize = () => {};
  this.cols = 80;
  this.rows = 24;
  this.write = () => {};
  this.dispose = () => {};
}
function FitAddon(this: { fit: () => void }) { this.fit = () => {}; }
const context: Record<string, unknown> = {
  document: {
    getElementById() {
      return { style: {}, textContent: "", appendChild() {} };
    },
    createElement: element,
  },
  location: { hash: "", search: "" },
  fetch: async () => ({ ok: false, json: async () => [] }),
  setInterval: () => 0,
  console,
  URLSearchParams,
  Terminal,
  FitAddon: { FitAddon },
  addEventListener: () => {},
};
context.window = context;
vm.createContext(context);
vm.runInContext(readFileSync(new URL("../src/console/app.js", import.meta.url), "utf8"), context);
const addPane = context.addPane as (agent: { name: string; id?: string; role?: string; status: string }) => void;

let checks = 0;
const ok = (cond: boolean, message: string, extra?: string): void => {
  assert.ok(cond, extra === undefined ? message : `${message}\n${extra}`);
  checks++;
  console.log(`  ✓ ${message}`);
};
function labelFor(name: string, id?: string): string {
  const before = panes.length;
  addPane({ name, ...(id === undefined ? {} : { id }), role: "worker", status: "running" });
  return panes[before]!.querySelector(".name").textContent;
}

ok(labelFor(" ", "local.blank") === "local.blank", "a whitespace console name is the id");
ok(labelFor("", "local.blank") === "local.blank", "an empty console name is the id");
const newline = labelFor("\n", "local.blank");
ok(newline === "local.blank" && !newline.includes("\n"), "a newline console name stays on one line as the id");
ok(labelFor(" ada", "local.blank") === " ada", "a console name with a leading space stays");
ok(labelFor("ada", "local.blank") === "ada", "a console name stays");
ok(labelFor(" ") === "(unnamed)", "a blank console name with no id is unnamed");

console.log(`manager console label: ${checks} checks passed`);
