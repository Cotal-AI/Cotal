---
"@cotal-ai/cli": minor
---

Report a partial `cotal ps` census instead of a listing that reads as the whole space

In a space served by two manager instances on different command contracts, `cotal ps` listed one
instance's seats, printed the other as a single refusal line, and exited 0. The refusal is correct:
the class scatter pins the contract from one instance's `describe`, and a manager that cannot honor
a pinned digest rejects rather than coerces (SPEC 13.7). The rendering was not. A refusal that hides
every seat behind it looks the same as an instance with no seats, which instance refuses follows
whichever one answers the describe, so the output swapped between calls, and the exit status said
the listing was complete either way. Measured on a live fixture: six seats running, one printed,
exit 0.

`ps` now counts the instances that did not report their seats and, when there is at least one, names
how many of how many did not, then exits non-zero. A silent registration and a refusal count the
same way, because the seats behind either are equally absent from the listing and the operator's
question has one answer for both. An instance that answers with no seats has reported, so a healthy
multi-manager space is unchanged. The per-instance rows are printed as before, and the notice goes
to stderr in both presentations, so `--json` stdout stays one JSON object per seat per line.

A contract mismatch also gets one plain line rather than only a SPEC citation on a row that moves
between calls: it names the pinned digest pair, the instance whose describe supplied it, and the
deployment rule behind it, which is that every manager of one space serves the same command
contract. The scatter now carries each refusal's structured error code beside its message, so this
is decided on the code rather than on the wording.
