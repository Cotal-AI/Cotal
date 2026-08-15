# Panel verdicts — landed verbatim, on fm-orchestrator's order

**Five seats, all pinned at `66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`, all acked that hash.
Three BLOCKs, one NO-BLOCK-with-P1s, one E2E stage (docs half passed, live half blocked).**

**Why these are files and not channel history:** *a verdict that lives only in a channel dies with
the instance that received it.* That happened to another lane tonight and cost it a night; this lane
already carries one **unrecoverable** objection from a departed reviewer (`DESIGN.md` §7.9 —
`rev2-meshctl-authority`, whose BLOCK's *substance* could not be reconstructed, only its existence).
**Four live BLOCKs is the same risk multiplied.** Landed before any of them is acted on, so the
record cannot be shaped by the fixing.

**Verbatim, not summarised.** Each file is the seat's own text as received. Where I disagree with a
seat, the disagreement goes in `RESULTS.md` or `DESIGN.md` **next to the claim it bears on** — never
by editing the verdict. A seat's wording is evidence about what it actually checked; a paraphrase
is evidence about what I understood.

| file | seat | disposition |
| --- | --- | --- |
| `mc-rev-authority.md` | authority / escalation lens | **BLOCK** — release-evidence |
| `mc-rev-refusal.md` | refusal taxonomy | **BLOCK** |
| `mc-rev-supervisor.md` | supervisor observability | **BLOCK — HIGH**, rescoped to shipped behaviour |
| `mc-rev-evidence.md` | evidence / suite integrity | **NO BLOCK** on the 93-cell roll-call, four P1s |
| `mc-e2e-user.md` | E2E, docs-only | docs half **COMPLETE, passed**; one MEDIUM doc finding (fixed) |
| `mc-e2e-user-2.md` | E2E, live half | **BLOCKED** by version skew, not by this code |

**The one line that binds all three BLOCKs together**, and it is the same defect wearing three
costumes: **a cell whose assertion holds in both the safe and the unsafe state.** `U5`/`E5` assert
that a cause string *appears*, under a label claiming a departure is *distinguishable*. The refusal
taxonomy classifies the *text* of a failure under a name claiming it classifies the *condition*.
`M7` measures the user-mode path with `authorizeActor = () => {}` under a label claiming it measures
an authorization boundary. **In all three the green is real and the name is a promise the green does
not keep.**
