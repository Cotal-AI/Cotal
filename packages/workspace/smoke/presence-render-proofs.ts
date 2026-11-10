import assert from "node:assert/strict";

export type SmokeProof = { path: string; anchor: string };

// Reviewed output assertions and the modules whose output they cover, including shared
// renderers called by those modules. Import reachability alone does not prove a route rendered.
const smokeProofs: { proof: SmokeProof; modules: string[] }[] = [
  {
    proof: { path: "extensions/connector-core/smoke/orientation.smoke.ts", anchor: "assert.match(o.peers.summary, /bob\\/worker \\(working · progress unknown\\)/," },
    modules: ["extensions/connector-core/src/orientation.ts"],
  },
  {
    proof: { path: "extensions/connector-core/smoke/orientation.smoke.ts", anchor: "assert.match(result.text, /bob\\b[^\\n]* — working[^\\n]* · progress unknown/," },
    modules: ["extensions/connector-core/src/tool-specs.ts"],
  },
  ...[
    'check("9a a waiting request\'s status names the role\'s holder online now, by name and id"',
    'check("9b with no holder online it says none is"',
    'check("9c a failed roster read reads unknown, not empty"',
  ].map((anchor) => ({ proof: { path: "extensions/connector-core/smoke/anycast-take-gate-auth.smoke.ts", anchor }, modules: ["extensions/connector-core/src/tool-specs.ts"] })),
  {
    proof: { path: "implementations/cli/smoke/chat-pure.smoke.ts", anchor: 'check("/who names a working peer\'s progress as unknown"' },
    modules: ["implementations/cli/src/chat/controller.ts"],
  },
  {
    proof: { path: "implementations/cli/smoke/chat-pure.smoke.ts", anchor: 'check("the picker names a working peer\'s progress as unknown"' },
    modules: ["implementations/cli/src/chat/picker.ts"],
  },
  {
    proof: { path: "implementations/manager/smoke/cli-seat-locality.smoke.ts", anchor: 'check("ps textual working mesh row names unknown progress", /working · progress unknown/.test(ps.out), ps.out.slice(-1200));' },
    modules: ["implementations/cli/src/commands/agents.ts"],
  },
  {
    proof: { path: "implementations/cli/smoke/who-roster.smoke.ts", anchor: 'check(\n    "the rich report is colored, marks each state and keeps every state word",' },
    modules: ["implementations/cli/src/commands/who.ts"],
  },
  {
    proof: { path: "implementations/cli/smoke/console-status-row.smoke.ts", anchor: 'check("a working seat renders `mesh working · progress unknown`", working.includes("mesh working · progress unknown"), working);' },
    modules: ["implementations/cli/src/console/commands.ts"],
  },
  {
    proof: { path: "implementations/cli/smoke/console-palette.smoke.tsx", anchor: 'assert.ok(row.includes("mesh working · progress unknown")' },
    modules: ["implementations/cli/src/console/ui/CommandPalette.tsx"],
  },
  {
    proof: { path: "implementations/cli/smoke/view.smoke.ts", anchor: 'check("the watch roster names a working agent\'s progress as unknown"' },
    modules: ["implementations/cli/src/watch-json.ts", "implementations/cli/src/watch-view.tsx"],
  },
  {
    proof: { path: "implementations/web/smoke/session.smoke.ts", anchor: 'ok("turn title: open while working reads \\"Working for 3m 2s\\""' },
    modules: ["implementations/web/client/src/ui/panel/SessionPreview.tsx", "implementations/web/client/src/ui/work/Turn.tsx"],
  },
  {
    proof: { path: "implementations/web/smoke/panel.smoke.ts", anchor: 'ok("8.9 beside the peek, the agent\'s page ends its work with the full footer: the status presence reports, with its activity"' },
    modules: ["implementations/web/client/src/ui/session/SessionFoot.tsx", "implementations/web/client/src/ui/views/AgentPage.tsx"],
  },
  {
    proof: { path: "implementations/web/smoke/session-view.smoke.ts", anchor: 'ok("5.3 the header Badge says the status presence reports, Working, for an agent whose progress is unknown, with no progress claim"' },
    modules: ["implementations/web/client/src/ui/views/AgentPage.tsx"],
  },
  {
    proof: { path: "implementations/web/smoke/agents-view.smoke.ts", anchor: 'ok("11.6 a working row whose call has finished shows no step line, and keeps View work"' },
    modules: ["implementations/web/client/src/ui/views/AgentsView.tsx"],
  },
  {
    proof: { path: "implementations/web/smoke/views.smoke.ts", anchor: 'ok("3.3 a member whose connector reports no progress reads working with its activity, with no moving dots"' },
    modules: ["implementations/web/client/src/ui/views/ChannelView.tsx", "implementations/web/client/src/ui/WorkingLine.tsx"],
  },
  {
    proof: { path: "implementations/web/smoke/views.smoke.ts", anchor: 'ok("7.9 a conversation draws the working line for its working party only, after its messages"' },
    modules: ["implementations/web/client/src/ui/views/DmView.tsx"],
  },
];

export function assertSmokeProof(module: string, proof: SmokeProof, body: string): void {
  const count = body.split(proof.anchor).length - 1;
  assert.equal(count, 1, `honest-text proof anchor must exist exactly once in ${proof.path} but occurs ${count} time(s): ${proof.anchor}`);
  assert.match(proof.anchor, /assert|check|ok\(/, `smoke proof is not an output assertion: ${proof.path}: ${proof.anchor}`);
  assert.ok(smokeProofs.some((binding) => binding.proof.path === proof.path && binding.proof.anchor === proof.anchor && binding.modules.includes(module)),
    `smoke proof has no reviewed output coverage for ${module}: ${proof.path}: ${proof.anchor}`);
}
