// CLI: point at a public GitHub PR and run the benchmark-winning recipe live on Cotal.
//
//   pnpm run review -- <pr-url> [--instances N] [--k K] [--mock]
//
// Starts a local broker, brings up the reviewer daemon (N instances), fetches the PR, runs the
// orchestrator (freeze -> 3 scatters -> group -> merge -> k-of-N vote), prints the survivors, and
// tears everything down. `--mock` returns canned findings (no model quota, no network needed).
import { mintLifecycleUid } from "@cotal-ai/core";
import { fetchPrPacket } from "./github.js";
import { canaryModel } from "./personas.js";
import { startBroker } from "./space.js";
import { startReviewer } from "./reviewer.js";
import { reviewPr } from "./orchestrator.js";
import { SAMPLE_PR } from "./fixtures/sample-pr.js";

function parseArgs(argv: string[]) {
  let url: string | undefined;
  let instances = 3;
  let k = 3;
  let mock = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mock") mock = true;
    else if (a === "--instances") instances = Number(argv[++i]);
    else if (a === "--k") k = Number(argv[++i]);
    else if (!a.startsWith("--")) url = a;
  }
  return { url, instances, k, mock };
}

async function main() {
  const { url, instances, k, mock } = parseArgs(process.argv.slice(2));
  if (!url && !mock) {
    console.error("usage: pnpm run review -- <github-pr-url> [--instances N] [--k K] [--mock]");
    process.exit(2);
  }
  if (!mock) {
    process.stdout.write("model canary... ");
    await canaryModel();
    console.log("ok");
  }
  const space = "review";
  const packet = url ? await fetchPrPacket(url) : SAMPLE_PR;
  const reviewTimeoutMs = Number(process.env.COTAL_REVIEW_TIMEOUT_MS || 600_000);
  const deadlineMs = mock ? 8_000 : reviewTimeoutMs + 60_000;

  console.log(`${mock ? "[mock] " : ""}reviewing ${packet.prUrl}`);
  console.log(`  ${instances} instances, keep findings in >= ${k} of ${instances} runs`);

  const broker = await startBroker();
  const instanceIds = Array.from({ length: instances }, () => mintLifecycleUid());
  const reviewer = await startReviewer({ url: broker.url, space, instanceIds, mock });
  try {
    const result = await reviewPr({ url: broker.url, space, packet, k, deadlineMs, mock });

    console.log("\nscatters:");
    for (const s of result.stats) {
      console.log(`  ${s.persona.padEnd(10)} complete=${s.complete} runs=${s.responders.length} missing=${s.missing} churn=${s.churn} duplicate=${s.duplicate}`);
    }
    console.log(`\nsurvived the ${k}-of-${instances} vote: ${result.voted.length} finding(s)`);
    for (const f of result.voted) {
      const at = f.path ? `${f.path}${f.line !== null ? `:${f.line}` : ""}` : "(no location)";
      console.log(`  [${f.severity}] ${at}  (support ${f.support}/${instances})\n    ${f.body}`);
    }
  } finally {
    await reviewer.stop();
    broker.stop();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
