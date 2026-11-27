import { join } from "node:path";
import { createHash } from "node:crypto";
import { launchSharedSeat, openSharedSeat } from "@cotal-ai/seat";
import type { AgentHandle, LaunchSpec } from "@cotal-ai/core";
import { logicalExecutionEntry } from "@cotal-ai/workspace";
import { custodyRoot } from "./custodial-pty.js";
import { LegacyPtyRuntime } from "./pty.js";

export class SharedPtyRuntime extends LegacyPtyRuntime {
  constructor(private readonly root = sharedRoot()) { super(); }

  override spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    const id = launchSharedSeat({ root: this.root, name, spec, cwd });
    const handle = openSharedSeat(this.root, id);
    // Released lifecycle transactions are admitted separately from process custody.
    // Keep today's Manager stop and update policy until that transaction is enabled.
    const { release: _release, reference: _reference, ...controlled } = handle;
    return controlled;
  }
}

function sharedRoot(): string {
  const entry = logicalExecutionEntry() ?? process.argv[1] ?? process.execPath;
  const key = createHash("sha256").update(entry).digest("hex").slice(0, 12);
  return join(custodyRoot(), `p-${key}`);
}
