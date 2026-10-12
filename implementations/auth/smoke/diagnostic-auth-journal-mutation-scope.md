# Auth journal mutation scope

The original ten definitions are partitioned by their existing execution needs.
No target ID, source anchor, replacement, named assertion, command or restoration
requirement changes.

| Fixture | Original target IDs | Source-derived admission |
| --- | --- | --- |
| `mutations/diagnostic-auth-journal-unit.json` | DJM04, DJM05, DJM06, DJM07, DJM08, DJM10 | Six broker-free targets are eligible for maintained command admission |
| `mutations/diagnostic-auth-journal.json` | DJM01, DJM02, DJM03, DJM09 | Four live targets remain refused |

The unit fixture names only `diagnostic-auth-journal.smoke.ts`. Its commands
build core and auth, then run the existing unit suite. Every original
`afterRestore` rebuilds and runs that same suite. The suite uses shipped journal
classes and the private equality join. It starts no broker and invokes no live
entry. These checks do not replace native Endpoint or callout reachability.

The original fixture remains visibly live. It names the unchanged live source
and its unchanged live mutation commands. The maintained safety rule refuses
this fixture before target execution. No suite is renamed, moved, wrapped or
hidden, and no runner or safety policy is changed. The six definitions are
removed from the original fixture, so every original target appears once.

Admission eligibility is source-derived, not an executed checker verdict.
The sanctioned workflow must still apply the maintained contract and establish
a green baseline before any named mutation can be graded. A named kill must
reach its original assertion. Source restoration and rebuilding from restored
source must succeed. All six targets are unexecuted here. All four live targets
are also unexecuted, with their proof obligations still blocked.

Earlier ten unit and four live ordinary passes are not mutation proof.
No all-ten kill or restoration result is claimed. This partition does not
resolve canonical renewal CR-PROOF03, CR-PROOF04 or CR-PROOF05. Authentic server
approval, required integration checks and final acceptance or deployment holds
remain separate. Source review is not permission to execute or bypass a refusal.
