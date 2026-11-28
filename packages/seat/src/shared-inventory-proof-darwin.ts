import type { Socket } from "node:net";
import { darwinHostTransport } from "./shared-control-darwin.js";
import { darwinSharedIdentity, type DarwinSharedIdentity } from "./shared-identity-darwin.js";
import { sampleDarwinLineage, type DarwinGenerationAddress, type DarwinLineageObservation } from "./shared-inventory-darwin.js";

type Authority = { address: string; verify(identity: Readonly<DarwinSharedIdentity>): void | Promise<void> };
const hostLimit = 8;
const timeoutMs = 1500;

type Observation = Extract<DarwinLineageObservation, { state: "sampled" }>;

function revision(sample: Observation): string {
  return JSON.stringify(sample.generations.map(generation => generation.state === "recorded"
    ? { ...generation, seats: [...generation.seats] } : generation));
}

/** Corroborate the live hosts in one lineage. No writer is claimed and no socket is handed to the
 * caller. The result grants neither stop authority nor an admission fence or proof of emptiness. */
export async function corroborateDarwinLineage(
  lineage: string,
  addressFor: (generation: string) => DarwinGenerationAddress,
  authorityFor: (generation: string) => Authority,
): Promise<DarwinLineageObservation> {
  const before = sampleDarwinLineage(lineage, addressFor);
  if (before.state !== "sampled" || !before.generations.length || before.generations.length > hostLimit) return { state: "unknown" };
  const stamp = revision(before);
  const peers: Array<{ connection: Socket; identity: DarwinSharedIdentity }> = [];
  try {
    // Wait for every dial to settle so a refusal cannot leave a successful peer unclosed.
    const checks = await Promise.allSettled(before.generations.map(async generation => {
      if (generation.state !== "recorded" || generation.lifetime !== "live") throw new Error("unverified Darwin PTY generation");
      const { socket, ...host } = generation.host;
      const connection = await darwinHostTransport.dial(socket, { ...host, authority: authorityFor(generation.generation) }, timeoutMs);
      peers.push({ connection, identity: host.identity });
    }));
    if (checks.some(check => check.status === "rejected")) return { state: "unknown" };
    const after = sampleDarwinLineage(lineage, addressFor);
    if (after.state !== "sampled" || stamp !== revision(after) || peers.some(({ connection, identity }) =>
      connection.destroyed || !darwinSharedIdentity.matchesPeer(connection, identity))) return { state: "unknown" };
    return after;
  } catch { return { state: "unknown" }; }
  finally { for (const { connection } of peers) connection.destroy(); }
}
