import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { requireSpawnDiscovery } from "./spawn-discovery.js";
import cotalMesh from "./standalone.js";

export default function spawnedCotalMesh(pi: ExtensionAPI): Promise<void> {
  requireSpawnDiscovery();
  return cotalMesh(pi);
}
