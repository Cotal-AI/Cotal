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

Built to be incapable of three failures:

1. **Terms read as regex.** Fixed with `-F`, and *proven per term* by feeding each term a document
   containing exactly itself. A term that cannot match its own literal is not a warning, it is
   refusal code 94.
2. **Comment and blank lines scanned as terms.** Stripped — and **every dropped line is checked for
   being term-shaped first**, because the dangerous direction is a real term sitting behind a `#`.
   That is refusal 93, not a silent drop.
3. **A clean indistinguishable from "never looked".** Distinct refusals for unreadable terms file
   (95) and zero terms parsed (93), controls in both directions, and **the coverage count printed
   beside the verdict.** A bare `CLEAN` is not an output this program can emit.

### The guards are driven, not asserted in prose

| Guard | Driven | Result |
| --- | --- | --- |
| unreadable terms file | `leakscan.sh /nonexistent …` | `REFUSED(95)`, rc=95 |
| all-comment terms file | 3 lines, 0 terms | `REFUSED(93)`, rc=93 |
| a term-shaped **comment** | `# secret-project-name` | `REFUSED(93)` naming the line, rc=93 |
| regex-hostile terms, clean doc | 4 terms | `CLEAN — coverage 4/4`, rc=0 |
| regex-hostile terms, dirty doc | same 4 | `LEAK`, rc=1 |

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

Re-measured across dialects, each term fed a document containing exactly itself:

| Term | BRE (`grep`) | ERE (`grep -E`) | `grep -F` |
| --- | --- | --- | --- |
| `a+b-service` | match | **MISS** | match |
| `node(v2)` | match | **MISS** | match |
| `proj.io` | match | match | match |
| `c++core` | match | **MISS** | match |
| `a[b-core` | **MISS** | **MISS** | match |
| `back\slash` | **MISS** | **MISS** | match |
| `x\{2` | **MISS** | **MISS** | match |
| `p^q` | **MISS** | **MISS** | match |
| `a$b` | **MISS** | **MISS** | match |

> **BRE silently drops 5 of 9. ERE silently drops 8 of 9. `-F` recovers all 9.**

**This sharpens the fleet finding rather than restating it: the size of the hole depends on which
dialect the scanner used, and `-E` — the flag a careful person adds to get better regexes — makes it
dramatically worse.** A scanner "improved" by adding `-E` gets quieter and blinder at the same time.

## The audit result

Terms were **derived from this box** rather than from memory: every non-Cotal project directory
under `~` and `~/[REDACTED-BOUNDARY-TERM]`, expanded one level. **172 candidate terms.** The list stayed in a
scratch directory and is not reproduced here.

| Surface | Coverage | Terms hitting | Verdict |
| --- | --- | --- | --- |
| `.meshctl-measurement/*` (17 committed files) | 172/172, each self-match-verified | 14 | clean after review |
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

## What this does NOT establish

- **Not scanned against the canonical list, because it is unreachable here.** The 172 terms are
  derived from directory names on one box. **A private name that is not a directory on this machine
  is not in the list and was not scanned.** This is the audit's real bound and it is not small.
- **Coverage is over the terms supplied**, which is exactly the property the coverage count reports.
  `172/172` means every supplied term was verified scannable — not that the supply was complete.
- **Committed artifacts only.** Mesh messages this lane has already sent are not recoverable from
  the tree and were not scanned.
- **No claim about any other lane.** The method is shareable; the result is this lane's alone.
