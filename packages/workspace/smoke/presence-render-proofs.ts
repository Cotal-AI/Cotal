import assert from "node:assert/strict";

export type SmokeProof = { path: string; anchor: string };
export type ProofEntry = { path: string; anchor: string; class: string; proof?: SmokeProof };
type Binding = { proof: SmokeProof; sites: { path: string; anchors: string[] }[] };

// Reviewed output assertions and the individual sinks they read. A module can render several
// unrelated outputs, so neither an import nor another assertion about that module is coverage.
const smokeProofs: Binding[] = [
  {
    proof: { path: "extensions/connector-core/smoke/orientation.smoke.ts", anchor: "assert.match(o.peers.summary, /bob\\/worker \\(working · progress unknown\\)/," },
    sites: [{ path: "extensions/connector-core/src/orientation.ts", anchors: ['`${peerLabel(p.card)} (${honestStatus(p.status)})`', "honestStatus(p.status)"] }],
  },
  {
    proof: { path: "extensions/connector-core/smoke/orientation.smoke.ts", anchor: "assert.match(text, /status: working · progress unknown · attention: open/," },
    sites: [{ path: "extensions/connector-core/src/orientation.ts", anchors: ['`  • status: ${honestStatus(o.status)} · attention: ${o.attention}`', "honestStatus(o.status)"] }],
  },
  {
    proof: { path: "extensions/connector-core/smoke/orientation.smoke.ts", anchor: "assert.match(result.text, /bob\\b[^\\n]* — working[^\\n]* · progress unknown/," },
    sites: [{ path: "extensions/connector-core/src/tool-specs.ts", anchors: ['`${preface}Present in "${config.space}" (${roster.length}):\\n${lines.join("\\n")}`'] }],
  },
  {
    proof: { path: "extensions/connector-core/smoke/anycast-take-gate-auth.smoke.ts", anchor: 'check("9a a waiting request\'s status names the role\'s holder online now, by name and id"' },
    sites: [{ path: "extensions/connector-core/src/tool-specs.ts", anchors: ['`Request seq ${seq} on @${status.role} is waiting on the queue, and no holder has taken it (${holdersLine(holders, "now")}). ` +\n      `A busy holder may already have it. If that holder does not confirm it in time, it goes back on the queue for a holder. Cancel it with seq ${seq} and cancel: true.`'] }],
  },
  {
    proof: { path: "extensions/connector-core/smoke/anycast-take-gate-auth.smoke.ts", anchor: 'check("9b with no holder online it says none is"' },
    sites: [{ path: "extensions/connector-core/src/tool-specs.ts", anchors: ['`Request seq ${seq} on @${status.role} is waiting on the queue, and no holder has taken it (${holdersLine(holders, "now")}). `'] }],
  },
  {
    proof: { path: "extensions/connector-core/smoke/anycast-take-gate-auth.smoke.ts", anchor: 'check("9c a failed roster read reads unknown, not empty"' },
    sites: [{ path: "extensions/connector-core/src/tool-specs.ts", anchors: ["renderAnycastStatus(status, holders)"] }],
  },
  {
    proof: { path: "implementations/cli/smoke/chat-pure.smoke.ts", anchor: 'check("/who names a working peer\'s progress as unknown"' },
    sites: [{ path: "implementations/cli/src/chat/controller.ts", anchors: ['`${oneLine(personLabel(r, shared))} · ${r.sessionKind === "chat" ? "human session" : oneLine(r.kind)}${r.role ? ` · ${oneLine(r.role)}` : ""} · ${r.status === "working" ? "working · progress unknown" : r.status}${r.activity ? ` · ${oneLine(r.activity)}` : ""}`'] }],
  },
  {
    proof: { path: "implementations/cli/smoke/chat-pure.smoke.ts", anchor: 'check("the picker names a working peer\'s progress as unknown"' },
    sites: [{ path: "implementations/cli/src/chat/picker.ts", anchors: ['`${row.sessionKind === "chat" ? "human session" : oneLine(row.kind)}${row.role ? ` · ${oneLine(row.role)}` : ""} · ${row.status === "working" ? "working · progress unknown" : row.status}`'] }],
  },
  {
    proof: { path: "implementations/manager/smoke/cli-seat-locality.smoke.ts", anchor: 'check("ps textual working mesh row names unknown progress", /working · progress unknown/.test(ps.out), ps.out.slice(-1200));' },
    sites: [{ path: "implementations/cli/src/commands/agents.ts", anchors: ['ng" };\n  if (r.mesh === "offline")\n    return { text: `${', 'ok" };\n  if (r.mesh === "waiting") return { text: `waitin', '`${r.mesh}${detail}`'] }],
  },
  {
    proof: { path: "implementations/cli/smoke/who-roster.smoke.ts", anchor: 'check(\n    "the rich report is colored, marks each state and keeps every state word",' },
    sites: [{ path: "implementations/cli/src/commands/who.ts", anchors: ['`${row.status === "working" ? "working · progress unknown" : row.status}${facts.condition}`', '"working"'] }],
  },
  {
    proof: { path: "implementations/cli/smoke/console-status-row.smoke.ts", anchor: 'check("a working seat renders `mesh working · progress unknown`", working.includes("mesh working · progress unknown"), working);' },
    sites: [{ path: "implementations/cli/src/console/commands.ts", anchors: ['`${peerLabel(a)} · ${a.agent} · ${a.mode} · ${a.status} · mesh ${meshWord(a)} · up ${Math.round(a.uptimeMs / 60000)}m`'] }],
  },
  {
    proof: { path: "implementations/cli/smoke/console-palette.smoke.tsx", anchor: 'assert.ok(row.includes("mesh working · progress unknown")' },
    sites: [{ path: "implementations/cli/src/console/ui/CommandPalette.tsx", anchors: ['`${row.agent} · ${row.status} · mesh ${meshWord(row)}`'] }],
  },
  {
    proof: { path: "implementations/cli/smoke/watch-output.tsx", anchor: 'assert.match(output, /\\balice\\b[^\\n]*working - progress unknown/, "the real watch stream prints working with unknown progress")' },
    sites: [{ path: "implementations/cli/src/watch-json.ts", anchors: ['emit("snapshot", data)'] }],
  },
  {
    proof: { path: "implementations/cli/smoke/watch-output.tsx", anchor: 'assert.match(frame, /\\balice\\b[^\\n]*working - progress unknown/, "the mounted watch view paints working with unknown progress")' },
    sites: [{ path: "implementations/cli/src/watch-view.tsx", anchors: ['{!shown.length ? <Text dimColor>{connected ? "Waiting for activity in this authorized view." : "No current feed. Events may be missing."}</Text> : shown.map((line, index) => <Text key={index}>{line}</Text>)}'] }],
  },
  {
    proof: { path: "implementations/web/smoke/panel.smoke.ts", anchor: 'ok("8.2 for a working agent the peek shows Now, with Working for on the right, over the open turn\'s last three steps, and no footer"' },
    sites: [{ path: "implementations/web/client/src/ui/panel/SessionPreview.tsx", anchors: ["turnTitle(turn, row.status, now)", "{title}"] }],
  },
  {
    proof: { path: "implementations/web/smoke/session-parts.smoke.ts", anchor: 'ok("3.1 the open working turn reads \\"Working for 3m 2s\\" in bold with the live spinner, never shimmers, and counts on"' },
    sites: [{ path: "implementations/web/client/src/ui/work/Turn.tsx", anchors: ["turnTitle(turn, row.status, now)", "{live ? <b>{title}</b> : title}", "{title}"] }],
  },
  {
    proof: { path: "implementations/web/smoke/panel.smoke.ts", anchor: 'ok("8.9 beside the peek, the agent\'s page ends its work with the full footer: the status presence reports, with its activity"' },
    sites: [{ path: "implementations/web/client/src/ui/session/SessionFoot.tsx", anchors: ['  return (\n    <div key={row.status} className={fade ? `ox-f', '{` is ${status} `}', '` is ${status} `'] }],
  },
  {
    proof: { path: "implementations/web/smoke/session-view.smoke.ts", anchor: 'ok("2.10 every work-list branch renders the held work and its reported working footer"' },
    sites: [{ path: "implementations/web/client/src/ui/views/AgentPage.tsx", anchors: [
      "ayloadRead} work={work} row={row} condition={condition} h",
      "adRead} work={work} row={row} condition={condition} h",
      "{steps.length > 0 && list}",
      "   </PlaneNote>\n        {list}\n      </div>\n    );\n  }",
      "{body}",
      "ker>\n        )}\n        {list}\n      </div>\n    );\n  }",
    ] }],
  },
  {
    proof: { path: "implementations/web/smoke/session-view.smoke.ts", anchor: 'ok("5.3 the header Badge says the status presence reports, Working, for an agent whose progress is unknown, with no progress claim"' },
    sites: [{ path: "implementations/web/client/src/ui/views/AgentPage.tsx", anchors: ["{known && <StatusWord row={known} />}"] }],
  },
  {
    proof: { path: "implementations/web/smoke/agents-view.smoke.ts", anchor: 'ok("11.6 a working row whose call has finished shows no step line, and keeps View work"' },
    sites: [{ path: "implementations/web/client/src/ui/views/AgentsView.tsx", anchors: ["runningCall(foldWork(frames, posts), row.status)"] }],
  },
  {
    proof: { path: "implementations/web/smoke/agents-view.smoke.ts", anchor: 'ok("11.4 a working row with a running call shows it under the activity line, with the spinner, the title and the tool with its seconds, and View work sits beside the button"' },
    sites: [{ path: "implementations/web/client/src/ui/views/AgentsView.tsx", anchors: ["call={running.call}", "{running.call}"] }],
  },
  {
    proof: { path: "implementations/web/smoke/views.smoke.ts", anchor: 'ok("3.3 a member whose connector reports no progress reads working with its activity, with no moving dots"' },
    sites: [
      { path: "implementations/web/client/src/ui/views/ChannelView.tsx", anchors: ["rows={working}", "{working}", "{working.length > 0 && (\n                <MessageScrollerItem>\n                  <WorkingLine rows={working} />\n                </MessageScrollerItem>\n              )}"] },
      { path: "implementations/web/client/src/ui/WorkingLine.tsx", anchors: ['{rows.slice(0, WORKING_SHOWN).map((r) => (\n        <Marker key={r.id} className="ox-wline">\n          <Avatar vendor={r.harness} status={r.status} size={18} dot={false} badge={badgeOf(r.id)} />\n          <MarkerContent className="ox-wline-c">\n            <b>{r.name}</b>\n            {` is ${statusLabel(r)}`}\n            {r.activity && <>{" "}<span className="ox-shimmer">{r.activity}</span></>}\n          </MarkerContent>\n          <a className="ox-act" href={formatRoute({ view: "agent", id: r.id, tab: "work" })}>\n            {phone ? "View" : <>View work<Icon icon={ArrowUpRight01Icon} size={16} /></>}\n          </a>\n        </Marker>\n      ))}'] },
    ],
  },
  {
    proof: { path: "implementations/web/smoke/views.smoke.ts", anchor: 'ok("7.9 a conversation draws the working line for its working party only, after its messages"' },
    sites: [{ path: "implementations/web/client/src/ui/views/DmView.tsx", anchors: [
      "rows={working}", "{working}",
      '{conv || sent > 0 ? (\n                <>\n                  {conv && cut && (\n                    <MessageScrollerItem>\n                      <Marker>\n                        <MarkerContent>Earlier messages aren\'t loaded</MarkerContent>\n                      </Marker>\n                    </MessageScrollerItem>\n                  )}\n                  {conv && <MessageList messages={conv.messages} idx={idx} peers={peers} self={self} />}\n                  {target && <OutgoingRows store={store} target={target} shown={shown} />}\n                  {working.length > 0 && (\n                    <MessageScrollerItem>\n                      <WorkingLine rows={working} />\n                    </MessageScrollerItem>\n                  )}\n                </>\n              ) : (\n                <MessageScrollerItem>\n                  <Empty>\n                    <EmptyHeader>\n                      <EmptyTitle>{`No direct messages with ${name} yet.`}</EmptyTitle>\n                    </EmptyHeader>\n                  </Empty>\n                </MessageScrollerItem>\n              )}',
      "{working.length > 0 && (\n                    <MessageScrollerItem>\n                      <WorkingLine rows={working} />\n                    </MessageScrollerItem>\n                  )}",
    ] }],
  },
];

export function assertSmokeProof(module: string, proof: SmokeProof, body: string, anchor: string): void {
  const count = body.split(proof.anchor).length - 1;
  assert.equal(count, 1, `honest-text proof anchor must exist exactly once in ${proof.path} but occurs ${count} time(s): ${proof.anchor}`);
  assert.match(proof.anchor, /assert|check|ok\(/, `smoke proof is not an output assertion: ${proof.path}: ${proof.anchor}`);
  assert.ok(smokeProofs.some((binding) => binding.proof.path === proof.path && binding.proof.anchor === proof.anchor
    && binding.sites.some((site) => site.path === module && site.anchors.includes(anchor))),
  `smoke proof has no reviewed output coverage for ${module}: ${anchor}: ${proof.path}: ${proof.anchor}`);
}

// Both the focused proof suite and the AST census validate the complete manifest. No missing
// proof or stale binding may turn a smaller set of checks into a green result.
export function assertSmokeProofCoverage(entries: readonly ProofEntry[], read: (path: string) => string): number {
  const used = new Set<string>();
  let checked = 0;
  for (const entry of entries) {
    if (entry.class !== "honest-text") continue;
    assert.ok(entry.proof, `honest-text entry lacks output/shared-renderer proof: ${entry.path}: ${entry.anchor}`);
    const source = read(entry.path);
    assert.ok(entry.anchor.length > 0 && source.split(entry.anchor).length - 1 === 1,
      `manifest anchor must exist exactly once in ${entry.path}: ${entry.anchor}`);
    const body = read(entry.proof.path);
    assert.equal(body.split(entry.proof.anchor).length - 1, 1, `honest-text proof anchor must exist exactly once in ${entry.proof.path}: ${entry.proof.anchor}`);
    if (!entry.proof.path.includes("/smoke/")) continue;
    assertSmokeProof(entry.path, entry.proof, body, entry.anchor);
    used.add(JSON.stringify([entry.path, entry.anchor, entry.proof.path, entry.proof.anchor]));
    checked++;
  }
  for (const binding of smokeProofs) {
    for (const site of binding.sites) {
      for (const anchor of site.anchors) {
        assert.ok(used.has(JSON.stringify([site.path, anchor, binding.proof.path, binding.proof.anchor])),
          `unused smoke proof binding: ${site.path}: ${anchor}: ${binding.proof.path}: ${binding.proof.anchor}`);
      }
    }
  }
  assert.ok(checked > 0, "manifest must exercise smoke proof coverage");
  return checked;
}
