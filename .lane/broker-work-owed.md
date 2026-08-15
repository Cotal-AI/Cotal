# Owed work — all of it needs a broker, so it waits for the box

**PRIORITY ORDER, set by fm-orchestrator: item 0 first, because it CLOSES A HAZARD rather than
measuring one.** The other two measure something; item 0 is the only one where a green is currently
unverified against a change already committed.

## 0. RUN `up-tls-routes-live` — HIGHEST PRIORITY

`bin/smoke/up-tls-routes-live.smoke.ts:551` asserts a **security** verdict with
`/connection\s+.*unreachable/` over the whole of `cotal status`'s output. This lane added a delivery
row to that output. The first phrasing — *"the mesh **connection** failed above (**unreachable**)"* —
**matched that regex by itself**, so an additive health line would have satisfied a security check
that the connection row had failed. It is reworded to name the *preflight*, and a cell asserts the row
does not match (with a positive control proving the regex matches the OLD phrasing).

**But that suite has not been run since the row was added.** The repair was derived by reading, not by
executing, and reading is how the hazard was found rather than proof that it is gone. This suite needs
a broker; run it before treating the near-miss as closed.

**A NEW CLASS WORTH CARRYING PAST THIS LANE:** nothing about the added line was defective in
isolation — no bad regex, no missing control, no false statement. **The defect existed only in the
relationship between two files, one of which the author had no reason to open.** An assertion whose
subject is "somewhere in this output" is weakened by anyone who widens the output. When adding to a
surface, grep for what asserts on that surface.

---

# The two measurements — both need a broker, both wait for the arm to close

Written 2026-08-15T06:4xZ. **NOT RUN.** Each costs the box a live broker and CPU, and the merge-base
sequence is load-sensitive, so running either now would be affordable in memory and unaffordable in
meaning. Recorded here so a successor inherits the work rather than my context.

## 1. Is `PROBE_DEADLINE_MS = 1_500` a measurement or a wish?

`implementations/cli/src/lib/delivery-caller.ts:36`. It is a **declared constant standing in for a
measurement** — my own defect class in mirror image. If a healthy daemon on a loaded box exceeds it,
the card renders `no-responder` and an operator reads "the daemon is gone" about a daemon that is
merely busy. This box has run at load 4.4 tonight.

**Design (so the run is not improvised under time pressure):**

- Ephemeral broker from a scratch dir, loopback. **First action asserts the broker URL is not
  `nats://broker.cotal.ai:4222`.** Record pids at creation; kill only those, exact-name matched; await
  each child's exit before deleting its scratch.
- One healthy daemon, agent-class caller (the profile the arms selected).
- Sample `requestDeliveryHealthProbe` round-trip **N=200** with a deadline far above the candidate
  (say 15s) so the sample is not censored by the very bound under test. **A deadline that truncates
  its own sample measures the deadline, not the daemon.**
- Repeat at several load levels, and **read the load from `/proc/loadavg` at each sample**, not once
  at the start. A one-minute average is a lagging figure — it is real, but its label is not "load
  right now", which is the family of error this lane keeps finding.
- Report the distribution, not a mean: p50/p95/p99/max, and **where 1500ms sits in it**.

**What would change the code:** if p99 at realistic load exceeds 1500ms, the constant is wrong and
should be derived (or the refusal should distinguish "deadline exceeded with a fresh lease" from
"no responder and a stale lease"). If p99 sits far below, the constant stands and is then a
*measured* constant, which is worth more than the same number arrived at by taste.

**What this canNOT settle:** an ephemeral single-daemon loopback broker is not the production
delivery plane. It bounds the local round-trip and nothing else, and the report must say so.

## 2. The `asyncErrors` second denial path

`delivery-caller.ts:46-58`. The header's two-path denial claim has been **narrowed** to what is
evidenced, and the field is labelled an unasserted diagnostic. To restore the stronger claim, a cell
must construct a **real denial** — an under-granted caller against a live broker — and assert that
`asyncErrors` is non-empty AND that the assessment independently returned a refusal. Both halves, or
it does not establish two paths.

**Inverse control required:** a correctly-granted caller against the same live broker must leave
`asyncErrors` EMPTY. Without it, a field that is non-empty on every run would satisfy the assertion
while proving nothing — the same vacuity that put L9 into the card-live suite.

## 3. The entry point — AND A SCOPE DEFECT FOUND WHILE COSTING IT

**MY FIRST ESTIMATE IN THIS FILE WAS WRONG AND IS CORRECTED HERE RATHER THAN QUIETLY DROPPED.** I
wrote that this cell "does not strictly need a broker … the cheapest of the three". The no-broker half
holds — an unreachable broker renders the `unreachable` row fine. The *cheap* half does not: the card
is `readyCard`, and its **only call site is `setup.ts:308`**, at the end of the full `cotal setup`
flow — after `ensureSkillsPlugin()`, `seedAgentSkills()`, and `offerGlobalInstall()`, which installs a
plugin and can **prompt**. Driving the real entry point means driving all of that. It is the most
expensive of the three, not the cheapest.

### THE FINDING THAT MATTERS MORE THAN THE CELL

Tracing that call site answered a question I had not thought to ask: **which command does an operator
actually run to see my row?**

- `readyCard` renders **only during `cotal setup`** — onboarding, and re-runs of onboarding.
- **`cotal status` has NO delivery health row.** Its only delivery reference is
  `status.ts:17,169` — `managerHasDeliveryMarker()`, a **BUILD marker** printing `· delivery-aware`
  vs `· old/unknown build`. That is a fact about which binary is installed, not about whether delivery
  is working.

So the charter's question — *"is delivery actually working right now"* — **is still unanswerable from
the command an operator would run to ask it.** I built the surface and wired it into the onboarding
card. The row is correct, tested, and **on the wrong command**.

**The comment that misled me is a documentation defect and I am reporting it, not fixing it:**
`setup.ts:472-473` describes `readyCard` as *"The `cotal · status` one-glance card"*. It is not; it is
the setup card. That comment is pre-existing, not mine, and it is exactly why I believed the row was
on the status path without checking. A wrong name on a function is a trap for the next person too.

**Recommended next work (fm-orchestrator's call, not mine):** wire the delivery row into
`status.ts`, where the question is actually asked. That is a behaviour change to a command this lane
does not own, so it is proposed rather than done.
