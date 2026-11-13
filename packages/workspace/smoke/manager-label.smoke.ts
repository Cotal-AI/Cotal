import assert from "node:assert/strict";
import type { Presence } from "@cotal-ai/core";
import { managerLabel } from "../src/control/seat.js";

let checks = 0;
const ok = (got: string, expected: string, message: string): void => {
  assert.equal(got, expected, message);
  checks++;
  console.log(`  ✓ ${message}`);
};

const row = (name: string, meta: Record<string, string> = {}, activity?: string): Presence => ({
  card: { id: "u_own.manager_x", name, kind: "endpoint", role: "manager", meta },
  status: "idle",
  ...(activity ? { activity } : {}),
  ts: 0,
});

ok(managerLabel(row(" ", { host: "pc" }, "supervisor (tmux)")), "pc/tmux", "a whitespace manager name is shown by host and runtime");
ok(managerLabel(row("", { host: "pc" }, "supervisor (tmux)")), "pc/tmux", "an empty manager name is shown by host and runtime");
ok(managerLabel(row("\n", { host: "pc" }, "supervisor (tmux)")), "pc/tmux", "a newline manager name is shown by host and runtime");
ok(managerLabel(row(" ada", { host: "pc" }, "supervisor (tmux)")), " ada", "a manager name with a leading space stays");
ok(managerLabel(row("factory", { host: "pc" }, "supervisor (tmux)")), "factory", "a named manager shows by its name");
ok(managerLabel(row("manager", { host: "pc" }, "supervisor (tmux)")), "pc/tmux", "the default name still shows by host and runtime");
ok(managerLabel(row(" ")), "u_own.manager_x", "a whitespace manager name with no host or runtime is the id");

console.log(`manager label: ${checks} checks passed`);
