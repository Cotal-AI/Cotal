// The orchestrator: a core-client (NOT an agent). It holds a caller credential and drives the run
// with `freezeExpectedSet` + `epScatter` — three scatters, one per persona, against a single frozen
// set. Grouping replies by instanceId reconstructs the runs; the deadline/partial-result bookkeeping
// (missing / churn / duplicate) comes from the scatter for free.
import {
  freezeExpectedSet,
  epScatter,
  registrationReconciler,
  mintLifecycleUid,
  type EpCaller,
  type EpScatterResult,
} from "@cotal-ai/core";
import { REVIEW_ENDPOINT, REVIEW_OWNER, PERSONAS, commandFor, inputContract, outputContract, type Finding, type PrPacket } from "./contracts.js";
import { connectNats, openSpaceKv, openJsm } from "./space.js";
import { mergeRun, clusterAndVote, type VotedFinding } from "./vote.js";

export interface ScatterStat {
  persona: string;
  complete: boolean;
  responders: string[];
  missing: number;
  churn: number;
  duplicate: number;
  unexpected: number;
  invalid: number;
}

export interface ReviewResult {
  caller: EpCaller;
  runIds: string[];
  runs: { instanceId: string; findings: Finding[] }[];
  voted: VotedFinding[];
  stats: ScatterStat[];
}

function findingsOf(res: EpScatterResult, instanceId: string): Finding[] {
  const att = res.replies.get(instanceId);
  if (!att || !att.reply.ok) return [];
  const data = att.reply.data as { findings?: Finding[] };
  return Array.isArray(data.findings) ? data.findings : [];
}

/** Review one PR: freeze -> 3 scatters -> group by run -> per-run merge -> cross-run k-of-N vote. */
export async function reviewPr(opts: {
  url: string;
  space: string;
  packet: PrPacket;
  k: number;
  deadlineMs: number;
  mock: boolean;
}): Promise<ReviewResult> {
  const nc = await connectNats(opts.url);
  try {
    const kv = await openSpaceKv(nc, opts.space);
    const jsm = await openJsm(nc);
    const caller: EpCaller = { owner: REVIEW_OWNER, actor: "orchestrator", uid: mintLifecycleUid() };

    // The run set: every live, READY instance at its frozen (registrationRevision, epoch).
    const frozen = await freezeExpectedSet(jsm, kv, opts.space, REVIEW_ENDPOINT);
    const runIds = frozen.map((f) => f.instanceId);

    const byPersona = new Map<string, EpScatterResult>();
    const stats: ScatterStat[] = [];
    for (const persona of PERSONAS) {
      const op = {
        endpoint: REVIEW_ENDPOINT,
        command: commandFor(persona),
        contract: { input: inputContract, output: outputContract },
        caller,
        args: opts.packet as unknown as Record<string, unknown>,
      };
      const res = await epScatter(nc, opts.space, op, {
        deadlineMs: opts.deadlineMs,
        expected: frozen,
        reconcileRegistration: registrationReconciler(jsm, opts.space, REVIEW_ENDPOINT, frozen),
      });
      byPersona.set(persona, res);
      stats.push({
        persona,
        complete: res.complete,
        responders: [...res.replies.keys()],
        missing: res.missing.length,
        churn: res.churn.length,
        duplicate: res.duplicate.length,
        unexpected: res.unexpected.length,
        invalid: res.invalid.length,
      });
    }

    // Group by run: run r is instance r's bughunter + keeper + sweeper replies, merged across the
    // 3 personas. A run missing a persona still contributes its other findings (a partial run).
    const runs = runIds.map((instanceId) => {
      const perPersona = PERSONAS.flatMap((persona) => findingsOf(byPersona.get(persona)!, instanceId));
      return { instanceId, findings: mergeRun(perPersona) };
    });

    const voted = await clusterAndVote(runs.map((r) => r.findings), opts.k, opts.mock);
    return { caller, runIds, runs, voted, stats };
  } finally {
    await nc.close();
  }
}
