import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CotalEndpoint } from "@cotal-ai/core";
import { configFromEnv, MeshAgent } from "@cotal-ai/connector-core";
import { recordMesh, removeMesh } from "@cotal-ai/workspace";

export async function checkPersonaRunning(
  root: string,
  servers: string,
  run: (args: string[]) => Promise<{ code: number | null; out: string }>,
  check: (name: string, cond: boolean, extra?: unknown) => void,
): Promise<void> {
  const space = "persona-running";
  const dir = join(root, ".cotal", "agents");
  mkdirSync(dir, { recursive: true });
  const definition = "---\nname: displayed\n---\n";
  const path = join(dir, "mismatch.md");
  writeFileSync(path, definition);
  writeFileSync(join(dir, "sibling.md"), definition);
  writeFileSync(join(dir, "displayed.md"), definition);

  const agent = new MeshAgent(configFromEnv({ COTAL_SPACE: space, COTAL_SERVERS: servers, COTAL_AGENT_FILE: path }));
  const legacy = new CotalEndpoint({ space, servers, card: { name: "sibling", kind: "agent" }, channels: [] });
  agent.on("error", (error) => console.error(error.message));
  legacy.on("error", (error) => console.error(error.message));
  const list = () => run(["personas", "list", "--running", "--space", space]);
  recordMesh({ space, server: servers, root, mode: "open", ts: new Date().toISOString() });
  try {
    agent.start();
    await agent.waitUntilConnected(10_000);
    const attributable = await list();
    check("personas marks the launched catalog entry running despite a different display name",
      attributable.code === 0 && /^mismatch\s+● running$/m.test(attributable.out), attributable);
    check("personas does not match unused files by display name or identical contents",
      attributable.code === 0 && /^displayed\s+○ not running$/m.test(attributable.out) && /^sibling\s+○ not running$/m.test(attributable.out), attributable);
    writeFileSync(path, "---\nname: edited\n---\n");
    await legacy.start();
    const unattributed = await list();
    check("personas reports unknown for an unattributed live agent",
      unattributed.code === 0 && /^sibling\s+\? running status unknown$/m.test(unattributed.out), unattributed);
    check("an edited catalog entry stays running when its source still matches",
      unattributed.code === 0 && /^mismatch\s+● running$/m.test(unattributed.out), unattributed);
    await Promise.all([legacy.stop(), agent.stop()]);
    const stopped = await list();
    check("offline presence does not count as running or unattributed",
      stopped.code === 0 && /^mismatch\s+○ not running$/m.test(stopped.out) && /^sibling\s+○ not running$/m.test(stopped.out), stopped);
  } finally {
    await Promise.all([legacy.stop(), agent.stop()]);
    removeMesh(space);
  }
}
