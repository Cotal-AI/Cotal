/** Observe the real manager smoke broker's store removal after delayed signal handling. */
import childProcess from "node:child_process";
import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { createSuite, skipSuite } from "../bin/smoke/sentinel.mjs";
import { createSpaceAuth } from "@cotal-ai/core";

if (process.platform !== "linux") skipSuite("broker stop-order proof uses Linux SIGSTOP and procfs");
const { check, finish } = createSuite();
const spawn = childProcess.spawn;
const remove = fs.rmSync;
let child;
let store;
let removals = [];
childProcess.spawn = function (program, args, options) {
  const launched = spawn.call(this, program, args, options);
  if (program === "nats-server" && Array.isArray(args) && args.includes("-c")) {
    child = launched;
    store = dirname(args[args.indexOf("-c") + 1]);
  }
  return launched;
};
fs.rmSync = function (path, options) {
  if (typeof path === "string" && store && resolve(path) === resolve(store)) {
    removals.push({ exited: child.exitCode !== null || child.signalCode !== null });
  }
  return remove.call(this, path, options);
};
syncBuiltinESMExports();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dead = () => child?.exitCode !== null || child?.signalCode !== null;
try {
  const { bootBroker } = await import("../implementations/manager/smoke/_boot-broker.ts");
  for (const paused of [false, true]) {
    const label = paused ? "delayed signal handling" : "normal shutdown";
    child = undefined; store = undefined; removals = [];
    const broker = await bootBroker(await createSpaceAuth(`stop-order-${paused ? "paused" : "normal"}`));
    let resume;
    try {
      check(`${label}: owns a live native broker and existing store`, Boolean(child?.pid && !dead() && fs.existsSync(store)));
      if (!child?.pid || dead() || !store) throw new Error("native broker observation did not arm");
      if (paused) {
        child.kill("SIGSTOP");
        let stopped = false;
        for (let i = 0; i < 100; i++) {
          const stat = fs.readFileSync(`/proc/${child.pid}/stat`, "utf8");
          stopped = stat.slice(stat.lastIndexOf(")") + 2).startsWith("T ");
          if (stopped) break;
          await wait(10);
        }
        check("delayed signal handling: native child is stopped before teardown", stopped);
        if (!stopped) throw new Error("SIGSTOP was not observed");
        resume = setTimeout(() => { if (!dead()) child.kill("SIGCONT"); }, 600);
      }
      await broker.stop();
      check(`${label}: removal was actually observed`, removals.length > 0, removals);
      check(`${label}: every store removal follows the child exit event`, removals.length > 0 && removals.every((r) => r.exited), removals);
      check(`${label}: teardown removed the owned store`, !fs.existsSync(store));
    } finally {
      clearTimeout(resume);
      if (child && !dead()) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill("SIGCONT");
        child.kill("SIGKILL");
        await exited;
      }
      if (store) remove(store, { recursive: true, force: true });
    }
  }
} finally {
  childProcess.spawn = spawn;
  fs.rmSync = remove;
  syncBuiltinESMExports();
}
finish();
