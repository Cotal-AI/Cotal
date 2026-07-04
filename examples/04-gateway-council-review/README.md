# Example 04: gateway council review

**A cross-vendor Cotal council audits a deliberately flawed LLM gateway.** This example turns the Glock-style "review council" idea into real Cotal agents: independent personas join one mesh, post findings to shared channels, use vetoes only for proved security/correctness failures, debate only when triggered, and leave a transcript you can inspect.

The target is `agentgw`, a small purpose-built gateway for a coding-agent CLI. It is intentionally realistic and intentionally flawed. It was modeled on the gateway shape of glock by smundhra, with permission as a design reference. No glock source is copied here.

## What it shows

- A manifest-defined team in `cotal.yaml`.
- Nine focused review personas, modeled after Glock's council perspectives.
- One OpenCode reviewer on `openai/gpt-5.5` in the same mesh as Claude reviewers.
- Deterministic gate JSON from `check-gates.ts` before and after a fix.
- Veto power limited to security and correctness.
- Debate gated behind concrete conflicts, not opened from the start.

## Channels

| Channel | Purpose |
| --- | --- |
| `general` | Operator and host coordination. |
| `review.gateway` | Packet, independent findings, fix diff, re-review. |
| `review.debate` | Used only for vetoes or concrete disagreements. |
| `review.verdict` | Deterministic gate JSON, veto table, final signoff. |

## Run

Prereqs: Cotal built, Claude Code available, OpenCode available, and `OPENAI_API_KEY` exported for the OpenCode reviewer.

Validate the team:

```bash
pnpm --dir ../.. cotal topology view -f examples/04-gateway-council-review/cotal.yaml
```

Run deterministic gates:

```bash
cd examples/04-gateway-council-review
./check-gates.ts > gates.before.json
```

Start the manifest mesh:

```bash
pnpm --dir ../.. cotal up -f examples/04-gateway-council-review/cotal.yaml
pnpm --dir ../.. cotal console --space gateway-review
```

Paste `GOAL.md` to `orchestrator`, and paste or send `gates.before.json` into `review.verdict`.

## Expected arc

1. Orchestrator posts the review packet to `review.gateway`.
2. Reviewers post independent findings.
3. Synthesizer writes a verdict table to `review.verdict`.
4. Debate opens only if a valid veto or concrete conflict appears.
5. Orchestrator fixes one highest-severity valid issue.
6. Operator re-runs `./check-gates.ts > gates.after.json`.
7. Affected reviewers re-check and sign off in `review.verdict`.

## Honesty framing

This is not a claim that Cotal found bugs in shipped third-party software. The gateway is Cotal-owned demo code with planted realistic flaws. The claim is that Cotal makes a multi-agent review process visible, auditable, cross-vendor, and replayable.
