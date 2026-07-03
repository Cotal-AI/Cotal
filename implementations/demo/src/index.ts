import { registry, type Command } from "@cotal-ai/core";
import { targetFlags } from "@cotal-ai/workspace";
import { demo } from "./demo.js";

/**
 * `@cotal-ai/demo` — the scripted-trace traffic generator as an operator-installed CLI extension
 * (a dev aid, installed by path: `cotal ext add ./implementations/demo`). Self-registers the
 * hidden `demo` command into the shared core Registry on import.
 */
const demoCommand: Command = {
  kind: "command",
  name: "demo",
  group: "Observe",
  // A dev/test traffic generator (see docs/protocol-view.md) — runnable, but kept off the
  // top-level help so it doesn't clutter the user-facing surface.
  hidden: true,
  summary: "replay a scripted multi-agent trace to exercise the console/web",
  flags: [
    ...targetFlags,
    { name: "interval", type: "string", value: "<ms>", description: "delay between messages" },
    { name: "once", type: "boolean", description: "one pass, then exit" },
  ],
  run: demo,
};
registry.register(demoCommand);
