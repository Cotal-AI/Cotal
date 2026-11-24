import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cotalMesh from "./standalone.js";
import { requireDiscoveryFilter } from "./spawn-discovery.js";

export default async function spawnedCotalMesh(pi: ExtensionAPI): Promise<void> {
  if (!process.env.COTAL_NAME?.trim()) throw new Error("pi connector: spawned Pi requires COTAL_NAME");
  requireDiscoveryFilter();
  await cotalMesh(pi);
}
