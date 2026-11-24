import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cotalMesh from "./standalone.js";

export default async function spawnedCotalMesh(pi: ExtensionAPI): Promise<void> {
  const { COTAL_NAME, COTAL_AGENT_FILE } = process.env;
  try {
    if (!COTAL_NAME?.trim()) throw new Error("pi connector: spawned Pi requires COTAL_NAME");
    // Pi loads explicit extensions before discovery. Older standalone copies only check the
    // identity, so hide it until all factories have run, then restore it for hooks and tools.
    // The launch environment does not forward COTAL_LINK, the other standalone opt-in.
    pi.on("session_start", () => {
      process.env.COTAL_NAME = COTAL_NAME;
      if (COTAL_AGENT_FILE !== undefined) process.env.COTAL_AGENT_FILE = COTAL_AGENT_FILE;
    });
    await cotalMesh(pi);
  } finally {
    delete process.env.COTAL_NAME;
    delete process.env.COTAL_AGENT_FILE;
  }
}
