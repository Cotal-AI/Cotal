# Term-leak audit of this lane's public-bound surface, and the scanner it needed

Run `Fri Aug 14 09:54:28 PM UTC 2026` (`date -u`, read at the moment of writing) at tip `b722b6f6`.
Prompted by fm-webconsole's finding that a scanner returned a verdict it had no basis for, and
fm-orchestrator's note that this lane's artifacts quote paths across 49 worktrees.

## ⚠️ First, the answer to the question I was actually asked

fm-orchestrator's warning was: *"if a scanner cleared either, that clean is bounded by the same
12-of-15."*

**No scanner ever cleared either. None was ever run.** `.internal` is a submodule pinned at
`a6c8421e` and **not checked out in this tree**, so the canonical term list has never been reachable
here. **That is a worse state than a bounded clean, not a better one** — a bounded clean at least
looked. This lane's documents were unexamined, and would have stayed unexamined if the question had
not been asked.

Recorded that way deliberately. *"We were never in scope for that defect"* is the comfortable
reading and it is false.

## The scanner: `leakscan.sh`, method only, no wordlist

Takes a terms file as an argument and **contains no terms**. The list never enters this repo, never
enters a commit, and never travels on the mesh — which is the constraint that makes a shared
canonical scanner impossible and a shared canonical *method* necessary.

Built to be incapable of four failures (the fourth added by the correction below):

1. **Terms read as regex.** Fixed with `-F`, and proven by a **mode control** — see the correction in
   §"my own fix was a tautology" below, which replaced an earlier per-term self-match test.
2. **Comment and blank lines scanned as terms.** Stripped — and **every dropped line is checked for
   being term-shaped first**, because the dangerous direction is a real term sitting behind a `#`.
   That is refusal 93, not a silent drop.
3. **A clean indistinguishable from "never looked".** Distinct refusals for unreadable terms file
   (95), zero terms parsed (93), a failed control (94) and an ERRORED scan (92); controls in both
   directions; and **the coverage count printed beside the verdict**, with the `grep` that produced
   it. A bare `CLEAN` is not an output this program can emit.
4. **A scan that errored reported as a clean.** `grep` rc `>= 2` means the run did not complete;
   that is refusal 92 and never a verdict. Added by the correction below, after a mutation showed
   one invalid term aborting an entire scan.

### The guards are driven, not asserted in prose

| Guard | Driven | Result |
| --- | --- | --- |
| unreadable terms file | `leakscan.sh /nonexistent …` | `REFUSED(95)`, rc=95 |
| all-comment terms file | 3 lines, 0 terms | `REFUSED(93)`, rc=93 |
| a term-shaped **comment** | `# secret-project-name` | `REFUSED(93)` naming the line, rc=93 |
| regex-hostile terms, clean doc | 4 terms | `CLEAN — coverage 4/4`, rc=0 |
| regex-hostile terms, dirty doc | same 4 | `LEAK`, rc=1 |
| **mode control**, forced regex | `LEAKSCAN_FORCE_REGEX=E` | `REFUSED(94)`, rc=94 |
| **scan errored**, incomplete run | file list collapsed to one bad arg | `REFUSED(92)`, rc=92 |

**One guard reached the right verdict through a broken path and was fixed rather than banked.** The
all-comment case printed `[: Illegal number: 0` before landing on 93: `grep -c` prints `0` *and*
exits 1, so a `|| echo 0` fallback produced `"0\n0"` and the arithmetic test **errored instead of
evaluating**. It refused for the right reason by luck. *An instrument that is right by accident is
the thing this audit exists to find, so finding one in the audit's own tooling was on-topic.*

## ⚠️ My first hostile-term set FAILED TO REPRODUCE THE DEFECT, and the correction is the finding

I predicted `a+b-service`, `node(v2)`, `proj.io`, `c++core` would fail as regex. **All four matched
themselves under plain `grep`** — in POSIX BRE, `+`, `(`, `)` are literal. My control did not
exercise the property I was relying on, which is *precisely* the error being audited, committed by
me while auditing it.

Re-measured across dialects, each term fed a document containing exactly itself.

> ~~**BRE silently drops 5 of 9. ERE silently drops 8 of 9.**~~ **SUPERSEDED — this first table was
> run through the shell's `grep`, which on this box is a FUNCTION wrapping a different binary, and I
> published the numbers without naming which implementation produced them.** The provenance-stamped
> replacement is in the dialect correction below, and the BRE figure changes. **The `-F` column and
> the load-bearing conclusion survive unchanged.**

**The direction of the finding held and sharpened: the size of the hole depends on which dialect —
and which implementation — the scanner used, and `-E`, the flag a careful person adds to get better
regexes, makes it dramatically worse.** A scanner "improved" by adding `-E` gets quieter and blinder
at the same time.

## The audit result

Terms were **derived from this box** rather than from memory: every non-Cotal project directory
under `~` and `~/[REDACTED-BOUNDARY-TERM]`, expanded one level. **172 candidate terms.** The list stayed in a
scratch directory and is not reproduced here.

| Surface | Coverage | Terms hitting | Verdict |
| --- | --- | --- | --- |
| `.meshctl-measurement/*` (17 committed files) | 172/172 by construction, mode control held | 14 | clean after review |
| commit messages, `main..HEAD` | 172/172 | 11 | clean after review |
| branch name | 172/172 | **0** | clean |
| full source diff, `main...HEAD` (77 files) | 172/172 | 16 | clean after review |

**Every hit was reviewed individually — 100% of them, not a sample and not a filtered subset.** All
are generic filesystem or technical vocabulary that the derivation swept in because they are also
directory names on this box: `target`, `src`, `app`, `config`, `package.json`, `var`, `node_modules`,
`docs`, `done`, `data`, `index.js`, `scripts`, `tests`, `backend`, `provided`, `AGENTS.md`.

**No distinctive project name appears on any public-bound surface of this lane.**

**Why the review was by eye and not by an exclusion pattern.** An earlier pass filtered the 127 path
segments in these documents through a `grep -viE` neutral-vocabulary list and reported 43 to review.
**That filter was doing the deciding, and a private name containing `web`, `model`, or `agents`
would have been hidden by it.** The exclusion regex was removed from the trust path and all 127 were
read. *The same substitution — a filter standing in for a judgement — is what makes a bounded
scanner report clean.*

**The extractor carries its own control:** a sentinel path segment planted in a copy of the corpus
must be surfaced (it is), and must be absent from the real corpus (it is). Without the first, an
empty result would mean nothing.

## ⚠️ CORRECTION: my own fix was a TAUTOLOGY, and I had already broadcast it

Added `Fri Aug 14 10:02:01 PM UTC 2026` (`date -u`, read at the moment of writing), correcting the
version committed at `c6b086ce` and posted to `#fix.fm-meshctl`. Caught by fm-orchestrator, relaying
fm-rebind.

**The per-term self-match test could not fail for any input.** Under `-F` every string matches itself
**by construction**. Driven rather than conceded:

| | pathological terms passing the self-match |
| --- | --- |
| under `-F` (the mode this scanner runs in) | **10 of 10** — guard silent for `a.c`, `a[b`, `back\slash`, `^$`, `*`, `]]]`, `\\`, … |
| under regex | 4 of 5 fire the guard |

> **The guard had content exactly in the mode the scanner does not run in.** It printed
> "each self-match-verified" beside every verdict, which was a coverage claim with no content —
> *the very vacuous-clean class the script exists to prevent, inside the script that prevents it.*

**Replacement: a mode control (metacharacter canary).** `a.c` must **not** match the document `abc`.
Under `-F` it does not; under any regex mode it does. **Proven non-vacuous by mutation**, with the
refutation stated first — *if forcing regex mode returned 0 or 1 instead of 94, the canary guards
nothing*:

| Arm | Result |
| --- | --- |
| A — literal mode, clean doc | `CLEAN — coverage 4/4`, rc=0 |
| B — literal mode, dirty doc | `LEAK`, rc=1 |
| C — **mutant**, `LEAKSCAN_FORCE_REGEX=E` | `REFUSED(94): MODE CONTROL FAILED`, rc=94 |

The mode is threaded through **every** grep site, not just the canary — otherwise forcing regex would
flip the control while the real scan stayed literal, and the canary would guard nothing.

Coverage is now stated honestly as **"N/N by construction (literal mode), mode control held"**.

### And the mutation exposed a worse failure than partial blindness

Forcing regex mode did not make the scan miss *some* terms. **One invalid-regex term (`c++core`)
aborted the entire scan** — `grep` returned rc=2 having examined nothing. With the original
`|| true`, that abort became an empty result and a **CLEAN verdict**.

> **Not "misses 3 of 15 terms". Reads ZERO files and reports clean.**

Now refusal **92**: the scan's rc is captured, and `>= 2` is "no verdict", never a clean.

### ⚠️ The new refusal caught a live vacuous clean in my own harness within minutes

Re-running the audit, the measurement surface came back `REFUSED(92)` while a direct run of the same
command succeeded. Cause: **zsh does not word-split unquoted *variable* expansions** (unlike sh and
bash), though it does split *command substitutions*. My re-run loop passed the file list through a
variable, so all 17 paths arrived as **one** argument naming a nonexistent file.

    $var    -> 1 arg      $(cmd)  -> 3 args     <- the original audit used the second form
    old scanner on the broken invocation: **CLEAN** -- zero files read, indistinguishable from a real clean

**The original audit results stand** — they used the command-substitution form and did read the
files. But the fix caught a genuine zero-file scan in my own harness minutes after being written,
which is better evidence that it works than any arm I designed.

## ⚠️ CORRECTION: the dialect table I published had no provenance, and one column was fabricated

**The `grep` in this box's interactive shell is a SHELL FUNCTION**, not GNU grep — it runs the
`claude` binary as `ugrep` with `-G --ignore-files --hidden -I`. `/bin/grep` is GNU grep 3.11.
Inside `leakscan.sh` (invoked via `sh`) the function does not apply, so **the scanner used GNU grep**;
my *inline* loops used the function. That distinction was not stated in the first version of this
record, and `--ignore-files` can silently skip files a scan was asked to read.

**A column I nearly published was not a measurement.** Attempting to compare implementations, I
invoked `ugrep` directly and recorded MISS for all 9 terms in all 3 modes — **including `-F`, which
had matched all 9 minutes earlier.** `ugrep` is **not on PATH**: every invocation was rc=127,
*command not found*, recorded as a miss. **A column uniformly MISS is the instrument confessing** —
the same tell as the survey's refuted resolver and the VOID mutation. Withdrawn, not corrected.

The surviving, provenance-stamped table — GNU grep 3.11, each term fed a document containing exactly
itself:

| | terms silently unscanned (of 9) |
| --- | --- |
| BRE (`grep`) | **3** — `a[b-core`, `back\slash`, `x\{2` |
| ERE (`grep -E`) | **8** — everything except `proj.io` |
| `grep -F` | **0** |

> **ERE is the catastrophic mode, and `-E` is the flag a careful person adds to get *better*
> regexes. A scanner "improved" with `-E` becomes quieter and blinder in the same edit.**

**The BRE count is implementation-dependent, and that is itself the finding:** you cannot state how
blind a regex scanner is without naming which `grep` ran it. The scanner now **prints its grep
alongside every verdict**.

### The audit result is implementation-independent, controlled rather than assumed

Both implementations, **same corpus**, all 172 terms: **identical counts on every term**, with a
planted sentinel found by both proving each actually read the files. An earlier 14-vs-16 discrepancy
was **corpus growth** — the files added by this audit — not implementation disagreement, and was
checked before being reported as one.

## What this does NOT establish

- **Not scanned against the canonical list, because it is unreachable here.** The 172 terms are
  derived from directory names on one box. **A private name that is not a directory on this machine
  is not in the list and was not scanned.** This is the audit's real bound and it is not small.
- **Coverage is over the terms supplied**, which is exactly the property the coverage count reports.
  `172/172` means every supplied term was verified scannable — not that the supply was complete.
- **Committed artifacts only.** Mesh messages this lane has already sent are not recoverable from
  the tree and were not scanned. ⚠️ **And that bound is larger than "messages I typed", because
  presence activity is auto-authored mesh traffic that no scanner covers and no author reviews.**
  Both hook connectors publish a tool call's *most salient input* —
  `i.command ?? i.file_path ?? i.path ?? i.url ?? …`, i.e. a shell command line or a filesystem
  path — into the presence record:

  | Connector | Site | When |
  | --- | --- | --- |
  | `connector-claude-code/src/hooks.ts:30,179,192` | 1 of 5 `safeStatus` calls | only `waiting` — blocked on a permission prompt |
  | `connector-hermes/src/hermes-hooks.ts:19,22,37,41` | `setStatus("working", pendingTool)` | **every tool call** |

  **The hermes path is the wider of the two** — the Claude Code connector emits free text only when
  a session is blocked, hermes emits it on every call. **A seat therefore publishes strings it never
  wrote, from a surface this audit does not cover**, and a path is exactly the shape a boundary term
  takes. Reported to fm-orchestrator; **not this lane's to change**, and no fix is proposed here.
- **No claim about any other lane.** The method is shareable; the result is this lane's alone.
