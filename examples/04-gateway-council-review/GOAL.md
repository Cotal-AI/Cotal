# Review packet: agentgw gateway, pre-flight before going public

Paste this whole file as the first message to `orchestrator`. The orchestrator posts it to `review.gateway`, posts deterministic gate output if available, and coordinates the council.

---

SECURITY / CODE REVIEW: agentgw, the LLM gateway for our coding-agent CLI

We are about to make the agentgw gateway public and enable BYO provider keys for all users. Before that, review the auth, key-handling, rate-limiting, bundle-delivery, and permission surfaces as they stand today. Review the code as it is, not a proposed change.

The public-launch changes we are lining up:
1. Open the gateway to public signups (device-flow auth for anyone).
2. Turn on BYO API keys so users store their own OpenAI / Anthropic keys.
3. Advertise the encrypted bundle as protecting proprietary agent logic.

Files in scope (all under `target/`):
- `target/server.ts` (routes and wiring)
- `target/auth.ts` (CLI token issue/validate, on-disk token persistence)
- `target/ratelimit.ts` (sliding-window limiter, Redis + memory fallback)
- `target/keys.sql` (BYO key storage schema + RLS, the schema of record)
- `target/keys.ts` (BYO key lookup + cache)
- `target/bundle.ts` (encrypted bundle delivery)
- `target/run.sh` and `target/README.md` (stated permission posture)

Known demo stubs, OUT of scope, do not report these:
- Device-code verification in `/auth/token` is stubbed; the route trusts the demo caller.
- `keys.ts` and `auth.ts` hold state in memory standing in for tables; review the storage model against `keys.sql`.
- `/llm` acknowledges instead of forwarding to a real provider.

Lanes:
- `review-correctness`: correctness and architecture. Has veto power for proved correctness failures.
- `review-security`: adversarial security. Has veto power for proved security failures.
- `review-fact`: validate claims in README, comments, gate JSON, and peer findings. No veto power.
- `review-edge-cases`: boundary cases, outages, restarts, horizontal scale, malformed inputs, expired tokens.
- `review-performance`: measurable scaling and resource behavior.
- `review-simplicity`: simpler safer fixes for misleading or over-complex designs.
- `review-maintainability`: misleading comments, undocumented assumptions, code/docs divergence.
- `review-data-integrity`: key/token persistence, cache invalidation, backups, deletion, revocation.
- `review-attack-surface`: exposed routes, auth boundaries, service-role blast radius, fallback behavior.
- `review-testing`: missing deterministic tests and regression checks.
- `synthesizer`: summarize findings, validate veto shape, trigger debate only when needed, and write the final verdict table.

Open questions:
- Q1: If Redis is unavailable or errors mid-request, does the rate limiter still bound abuse, or does it degrade to something bypassable by fanning out, restarting, or scaling horizontally.
- Q2: Are BYO provider keys actually protected, or is RLS the only thing between a plaintext key column and disclosure.
- Q3: Does the encrypted bundle protect proprietary logic, or only raise effort, given how the client obtains the decryption key.
- Q4: Where and how is the CLI auth token stored on disk and in the gateway, and what is the blast radius if a user's home dir or the token store leaks.
- Q5: Does the permission system described in the README match what `run.sh` and the code actually enforce.

Process:
- Before review, run `./check-gates.ts` from the example root and post the JSON to `review.verdict` or paste it into `review.gateway`.
- Reviewers first post independent ranked findings [BLOCKING | HIGH | MED | LOW] on `review.gateway`, citing exact `file:line`.
- Vetoes are allowed only from `review-security` and `review-correctness`. A veto must include exact `file:line`, proof, failure mode, and required fix.
- Debate is NOT open from the start. `synthesizer` opens `review.debate` only for a veto, a BLOCKING finding another reviewer disputes, severity disagreement of two or more levels, or security/correctness conflict.
- `synthesizer` writes the verdict table to `review.verdict`.
- The orchestrator fixes the single highest-severity valid finding, posts the diff, re-runs `./check-gates.ts`, and asks only affected reviewers to re-review.
- Converge to a final sign off on `review.verdict`.
