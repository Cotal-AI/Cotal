import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { darwinBootSession, darwinLaunchdJob, processStartTime } from "@cotal-ai/seat";
import { bootoutVerifiedDarwinSeatHost, darwinSeatHostAuthority, planRetainedDarwinSeatHost, verifyDarwinSeatHostPeer, type DarwinSeatHostScope } from "./seat-host-darwin.js";
import { observeRetainedDarwinSeatInstallation } from "./seat-installation-inventory-darwin.js";
import type { holdDarwinRemovalManagers, DarwinRemovalTarget } from "./seat-removal-manager-darwin.js";

type Installation = Omit<DarwinSeatHostScope, "space">;
type Fence = ReturnType<typeof holdDarwinRemovalManagers>;
type Sample = Extract<Awaited<ReturnType<typeof observeRetainedDarwinSeatInstallation>>, { state: "sampled" }>;
type Generation = Extract<Sample["lineages"] extends ReadonlyMap<string, infer L> ? L extends { generations: readonly (infer G)[] } ? G : never : never, { state: "recorded" }>;
type Host = { generation: Generation; plan: ReturnType<typeof planRetainedDarwinSeatHost>; socket: Socket };
const refuse = (detail: string) => new Error(`hosted-pty-remove: ${detail}`);

function exactDeath(identity: DarwinRemovalTarget["root"]): boolean {
  if (darwinBootSession() !== identity.bootId) return false;
  const birth = processStartTime(identity.pid);
  if (birth) return birth !== identity.start;
  try { process.kill(identity.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  return false;
}

async function pinHost(installation: Installation, space: string, generation: Generation, consent: () => boolean): Promise<Host> {
  type Authority = ReturnType<typeof darwinSeatHostAuthority>;
  const module = new URL("./shared-control-darwin.js", import.meta.resolve("@cotal-ai/seat"));
  const { darwinHostTransport } = await import(module.href) as { darwinHostTransport: {
    dial(address: string, host: Generation["host"] & { authority: Authority }, timeout: number): Promise<Socket>;
  } };
  const plan = planRetainedDarwinSeatHost({ ...installation, space }, generation.generation);
  const authority = darwinSeatHostAuthority(plan, consent);
  const socket = await darwinHostTransport.dial(generation.host.socket, { ...generation.host, authority }, 1500);
  return { generation, plan, socket };
}

function lifetime({ generation }: Host) {
  const { pid, start, bootId } = generation.host.identity;
  return { pid, start, boot: bootId };
}

async function confirmBootout(host: Host, consent: () => boolean): Promise<void> {
  bootoutVerifiedDarwinSeatHost(host.plan, lifetime(host), host.socket, consent);
  const deadline = Date.now() + 5000;
  do {
    if (darwinLaunchdJob(host.plan.label).state === "absent" && exactDeath(host.generation.host.identity)) return;
    await delay(50);
  } while (Date.now() < deadline);
  throw refuse("the exact host did not confirm exit after native removal");
}

/** The caller keeps both the installation and Manager fences through native service teardown. */
export async function removeDarwinHostedSeats(installation: Installation, attemptId: string, consent: () => boolean, fence: Fence): Promise<void> {
  const requireConsent = () => { if (!consent()) throw refuse("uninstall consent or its installation fence is no longer available"); };
  requireConsent();
  const sample = await observeRetainedDarwinSeatInstallation(installation, consent);
  if (sample.state !== "sampled") throw refuse("installation custody is unknown");
  const hosts: Host[] = [], prepared: Array<{ manager: ReturnType<Fence["pin"]>; targets: DarwinRemovalTarget[] }> = [];
  try {
    for (const [space, lineage] of sample.lineages) {
      const targets: DarwinRemovalTarget[] = [];
      for (const generation of lineage.generations) {
        if (generation.state !== "recorded" || generation.lifetime !== "live") throw refuse("host custody is unknown");
        for (const [id, seat] of generation.seats) {
          if (seat.state !== "recorded" || seat.lifetime !== "live") throw refuse("a seat reservation or root is not verified live");
          targets.push({ scope: generation.host.scope, id, host: generation.host.identity, root: seat.child });
          if (targets.length > 64) throw refuse("the Manager holds too many seats to verify removal");
        }
        hosts.push(await pinHost(installation, space, generation, consent));
      }
      if (targets.length) {
        requireConsent();
        const manager = fence.pin(space);
        prepared.push({ manager, targets });
        await manager.request(attemptId, "prepare", targets);
      }
    }
    requireConsent();
    for (const host of hosts) verifyDarwinSeatHostPeer(host.plan, lifetime(host), host.socket, consent);
    if (prepared.some(({ manager }) => !manager.recheck())) throw refuse("an incumbent Manager changed during preparation");
    for (const { manager, targets } of prepared) {
      requireConsent();
      await manager.request(attemptId, "stop", targets);
      if (targets.some(target => !exactDeath(target.root))) throw refuse("an exact PTY root exit was not confirmed");
    }
    for (const host of hosts) { requireConsent(); await confirmBootout(host, consent); }
  } finally {
    await Promise.allSettled(prepared.map(async ({ manager }) => manager.request(attemptId, "abort", [])));
    for (const host of hosts) host.socket.destroy();
  }
}
