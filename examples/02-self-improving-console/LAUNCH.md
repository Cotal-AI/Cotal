# Launch copy — 04 self-improving console demo

Ready-to-paste drafts + schedule for posting the demo. **Nothing is posted automatically — these are for you to fire.** Grounded in the `cotal_research` market-research corpus (the demo hits the strongest audience signals: TUI, orchestration-bottleneck, peer coordination, observability).

## Schedule (ET)
| When | Channel | Action |
|---|---|---|
| **Sun 06-21, late-morning → evening** | Reddit | Soft-launch r/ClaudeCode + r/cmux (per-sub copy below). Warm-up + feedback. |
| **Tue 06-23, ~9am** | Hacker News | Show HN — **once only** (HN buries reposts). |
| **Tue 06-23, right after HN** | X (company) | Hero thread; link the HN post. |
| **Tue 06-23** | X (personal) | Quote-RT the company thread. |

Be at the keyboard the first 1–2h on each channel — early velocity carries it. X goes **Tuesday** (peak weekday window + stacks with HN), not Sun/Mon.

## Framing rules
- Lead: *"4 agents, one goal — improve the console they run in. The orchestrator refused to relay; the agents settled the contract themselves; a different-vendor agent reviewed it; it shipped."*
- Show the lazygit-style TUI + the lazygit commit image + the DM-contract screenshot.
- Soft-pedal "self-improving" (meta-hook, not headline). Don't *say* "vendor-neutral" — *show* the OpenCode reviewer.
- Position vs cmux as **complementary** (cmux = where you run/watch agents; Cotal = the wire they coordinate over).

## Assets to attach
Final demo **video** · **lazygit image** (commit/diff) · **DM-exchange screenshot** · company X handle + repo/spec link.

---

## X — company hero thread
**1/** We gave four AI agents one goal: improve the terminal console they run inside.
No orchestrator relaying messages. Two of them agreed on the interface *themselves*, over DMs. A different-vendor agent reviewed the diff. Then it shipped.
60 seconds 👇 [VIDEO]

**2/** The task: add a live activity sparkline to the status bar.
The orchestrator dispatched it — then refused to relay the details: "settle the contract between yourselves."
So backend + UI DM'd each other and locked it: `rates.activity`, 15 buckets × 4s. [DM screenshot]

**3/** Then an OpenCode agent — a different vendor entirely — reviewed the change read-only and posted findings to the team channel.
Typecheck green. Committed. [lazygit screenshot]
Agents from different stacks, co-present on one wire, coordinating like a team.

**4/** That wire is Cotal: an open, vendor-neutral layer where a population of agents share presence, state, and handoff — in any topology.
Apache-2.0, alpha, and we want it stress-tested.
↳ `npx cotal-ai` · repo + spec: [link] · built at @weights_biases WeaveHacks

## X — personal account (quote-RT of 1/)
the bit that still gets me: the orchestrator wouldn't relay the contract. it made the two workers agree on the interface themselves, peer-to-peer — then a *different-vendor* agent reviewed it before it shipped. felt like a team, not a script. months of work behind this.

## Reddit — r/ClaudeCode (Sunday)
**Title:** We let 4 Claude Code agents rebuild our terminal UI — coordinating peer-to-peer, with a cross-vendor reviewer
**Body:** Builder voice. The orchestrator dispatched a feature (a live activity sparkline in the TUI) but refused to relay the technical contract — it made the `backend` and `ui` agents DM each other and agree the interface directly. Then an OpenCode agent (different vendor) reviewed it read-only and posted findings. Shipped typecheck-green. [video] Open, Apache-2.0, alpha. *"Where does this break for your setup? Roast it."*

## Reddit — r/cmux (Sunday)
**Title:** Ran a multi-agent swarm *inside cmux* — agents settled the contract peer-to-peer across panes, a cross-vendor agent reviewed it
**Body:** cmux made the multi-agent run watchable — each agent in its own pane. Underneath, they coordinated over a shared wire (Cotal): peer-to-peer, not orchestrator-relayed, with an OpenCode reviewer (different vendor) doing the review. Complement to cmux, not a replacement. [video showing the panes] Feedback welcome — where does the model break for how you run agents in cmux?
