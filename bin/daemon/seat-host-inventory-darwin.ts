import type { SeatRecord } from "@cotal-ai/seat";
import { darwinSeatHostAuthority, darwinSeatHostLineageRoot, darwinSeatHostSocket, planRetainedDarwinSeatHost, type DarwinSeatHostScope } from "./seat-host-darwin.js";

interface HostAddress { scope: string; socket: string }
interface Identity { pid: number; start: string; bootId: string; uid: number }
type Lifetime = "live" | "gone" | "unknown";
type Uncertain = { state: "unknown" };
type Seat = Uncertain | { state: "recorded"; record: Readonly<Omit<SeatRecord, "artifacts" | "artifactRoot">>; child: Identity; lifetime: Lifetime };
type Generation = { generation: string } & (Uncertain | { state: "recorded";
  host: HostAddress & { identity: Identity; protocol: 2; token: string };
  lifetime: Lifetime;
  seats: ReadonlyMap<string, Seat>;
});
type Lineage = Uncertain | { state: "sampled"; generations: readonly Generation[] };

type Corroborate = (
  lineage: string,
  addressFor: (generation: string) => HostAddress,
  authorityFor: (generation: string) => ReturnType<typeof darwinSeatHostAuthority>,
) => Promise<Lineage>;

/** Called only from the owned daemon. This joins the recorded sample to launchd and native socket
 * evidence, without claiming a writer, taking a launch fence or establishing installation coverage. */
export async function observeRetainedDarwinSeatLineage(scope: DarwinSeatHostScope): Promise<Lineage> {
  if (process.platform !== "darwin") return { state: "unknown" };
  try {
    const fixed = Object.freeze({ ...scope });
    const lineage = darwinSeatHostLineageRoot(fixed);
    const proofModule = new URL("./shared-inventory-proof-darwin.js", import.meta.resolve("@cotal-ai/seat"));
    const { corroborateDarwinLineage } = await import(proofModule.href) as { corroborateDarwinLineage: Corroborate };
    const plan = (generation: string) => planRetainedDarwinSeatHost(fixed, generation);
    return await corroborateDarwinLineage(lineage,
      generation => { const { label, id } = plan(generation); return { scope: label, socket: darwinSeatHostSocket(id) }; },
      generation => darwinSeatHostAuthority(plan(generation)));
  } catch { return { state: "unknown" }; }
}
