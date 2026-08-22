import assert from "node:assert/strict";
import { eventChannel, isAguiFramePart } from "@cotal-ai/core";
import { AguiEmitterHolder } from "@cotal-ai/connector-core";
import type { PiSessionRecord } from "../src/agui-map.js";

let pass = 0;
const check = (condition: unknown, name: string): void => {
  assert.ok(condition, name);
  pass++;
};

const holder = new AguiEmitterHolder<PiSessionRecord>(
  async () => {
    throw new Error("this unarmed control must never start an emitter");
  },
  () => assert.fail("an unarmed session must not report an emitter failure"),
);

// A normal Pi session never creates/adopts this holder. This negative checks that the lifecycle
// seam stays idle until COTAL_EVENTS explicitly arms it; no unarmed session emits a frame.
check(holder.path === undefined && !holder.running && holder.failure === undefined, "unarmed Pi session emits nothing");
check(eventChannel({ owner: "owner", actor: "actor" }) === "events.owner.actor", "observer channel is principal-keyed");
check(!isAguiFramePart({ kind: "text" }), "ordinary session data is not an AG-UI frame");
console.log(`pi AG-UI lifecycle smoke: ${pass} passed`);
