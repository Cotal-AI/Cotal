/**
 * harness/evaluate.ts <rundir> — judge one swarm run.
 *
 * GREEN = build OK (the worktree's @cotal-ai/cli typechecks) AND ≥1 genuine peer-to-peer
 * exchange (a unicast DM whose sender is a worker and recipient is not the orchestrator).
 *
 * Prints a verdict JSON to stdout (the loop appends it to ITERATIONS.md).
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

// evaluate.ts <repoDir> [transcriptPath]
const repoDir = process.argv[2] || process.cwd();
const transcriptPath = process.argv[3] || `${repoDir}/transcript.jsonl`;

type Rec = {
  type: string;
  mode?: string;
  from?: string;
  fromId?: string;
  to?: string; // instance id for unicast — resolve via the id→name map
  channel?: string;
  text?: string;
};

const recs: Rec[] = existsSync(transcriptPath)
  ? readFileSync(transcriptPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Rec;
        } catch {
          return null;
        }
      })
      .filter((r): r is Rec => r !== null)
  : [];

const msgs = recs.filter((r) => r.type === "message");

// --- build check (typecheck the cli IN the worktree) ---
// Invoke the worktree's own tsc directly (not `pnpm --filter`, which exits 0 when it
// matches no project — a false green if the worktree install failed).
let buildOk = false;
let buildErr = "";
try {
  execSync("./node_modules/.bin/tsc -p implementations/cli/tsconfig.json --noEmit", {
    cwd: repoDir,
    stdio: "pipe",
  });
  buildOk = true;
} catch (e) {
  const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
  buildErr = (
    (err.stdout?.toString() ?? "") +
    (err.stderr?.toString() ?? "") +
    (err.message ?? "")
  ).trim();
}

// --- comms analysis ---
// "Hubs" are not peers: a DM to/from any of these is orchestrator-routed, not peer-to-peer.
const HUB = new Set(["orchestrator", "manager", "cli", "harness-observer"]);
// `to` is an instance id; resolve it to a name via the id→name map built from `from`/`fromId`.
const idToName: Record<string, string> = {};
for (const m of msgs) if (m.fromId && m.from) idToName[m.fromId] = m.from;
const nameOf = (x?: string): string | undefined => (x && idToName[x] ? idToName[x] : x);

const dms = msgs.filter((m) => m.mode === "unicast");
const chats = msgs.filter((m) => m.mode === "chat");
// peer-to-peer DM: both ends are workers (neither is a hub), and it's not a self-message.
const peerDms = dms.filter((m) => {
  const from = m.from;
  const to = nameOf(m.to);
  return !!from && !!to && !HUB.has(from) && !HUB.has(to) && from !== to;
});
const peerPairs = [...new Set(peerDms.map((m) => `${m.from}->${nameOf(m.to) ?? "?"}`))];
const complete = msgs.some((m) => (m.text ?? "").includes("DEMO COMPLETE"));
const peerToPeer = peerDms.length >= 1;

// "wired": the swarm actually replaced the placeholders — app.tsx is a real component and the
// console-ink command renders it. Build+p2p can both pass with the UI unwired (iter 3), so
// green must require a working command too.
const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
const appSrc = read(`${repoDir}/implementations/cli/src/console/app.tsx`);
const cmdSrc = read(`${repoDir}/implementations/cli/src/commands/console-ink.tsx`);
const wired = appSrc.length > 200 && !appSrc.includes("TODO(demo)") && !/placeholder/i.test(cmdSrc);

const green = buildOk && peerToPeer && wired;

const failureMode = !msgs.length
  ? "no-traffic — agents never communicated (spawn/wake/TTY problem)"
  : !peerToPeer
    ? "star-topology — all comms via orchestrator, no peer-to-peer DMs"
    : !buildOk
      ? "build-failed — typecheck red"
      : !wired
        ? "ui-not-wired — mesh/components built but app.tsx/console-ink still placeholder"
        : "ok";

const verdict = {
  green,
  buildOk,
  peerToPeer,
  wired,
  complete,
  counts: {
    messages: msgs.length,
    chats: chats.length,
    dms: dms.length,
    peerDms: peerDms.length,
  },
  peerPairs,
  failureMode,
  buildErr: buildOk ? "" : buildErr.split("\n").slice(-12).join("\n"),
};

console.log(JSON.stringify(verdict, null, 2));
