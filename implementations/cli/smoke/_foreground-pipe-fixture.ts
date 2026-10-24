import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { defaultStartToken, type ProcessIdentityRecord } from "@cotal-ai/workspace";
import { finishOwnedChild, observeOwnedChild, ownedBirthLive, waitForOwnedChild } from "./_foreground-owned-child.js";

/** Real inherited-pipe regression, with safety exits and no product mutation or process scan. */
export async function checkInheritedPipeCleanup(): Promise<void> {
  for (const mode of ["exit", "SIGKILL"] as const) await inheritedPipeCell(mode);
}

async function inheritedPipeCell(mode: "exit" | "SIGKILL"): Promise<void> {
  const descendantScript = `process.send({ready:true});setInterval(()=>{},1000);setTimeout(()=>process.exit(0),15000);`;
  const ownerScript = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{detached:true,stdio:['ignore',1,2,'ipc']});child.on('message',()=>process.send({pid:child.pid}));process.on('message',()=>process.exit(0));setInterval(()=>{},1000);setTimeout(()=>process.exit(0),15000);`;
  const child = spawn(process.execPath, ["-e", ownerScript], { detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stdout?.resume(); child.stderr?.resume();
  const state = observeOwnedChild(child);
  let birth: ProcessIdentityRecord | undefined;
  child.on("message", (message: unknown) => {
    const pid = (message as { pid?: unknown }).pid;
    if (typeof pid !== "number") return;
    const token = defaultStartToken(pid);
    if (token !== undefined) birth = { pid, token };
  });
  const records = () => birth ? [birth] : [];
  try {
    await waitForOwnedChild(() => birth !== undefined, 3_000, "inherited-pipe birth ready");
    assert.ok(birth && ownedBirthLive(birth), "inherited-pipe descendant has an exact birth pin");
    if (mode === "exit") child.send("exit");
    else child.kill("SIGKILL");
    await waitForOwnedChild(() => state.exited, 2_000, "inherited-pipe owner exit");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(state.closed, false, "owner close waits on the surviving descendant's pipes");
    assert.ok(ownedBirthLive(birth), "pinned descendant remains live after owner exit");
    await finishOwnedChild(child, state, () => {}, records, "inherited-pipe regression");
    assert.equal(ownedBirthLive(birth), false, "shared cleanup stops the exact pinned birth");
    assert.equal(state.closed, true, "shared cleanup drains pipes after pinned stop");
    console.log(`PASS foreground-up-signals inherited-pipe ${mode}: exit observed before close, pinned birth stopped, streams drained`);
  } finally {
    await finishOwnedChild(child, state, () => {}, records, "inherited-pipe regression final cleanup");
  }
}
