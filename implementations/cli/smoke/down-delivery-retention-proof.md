# Delivery credential retention proof

The fixture in `mutations/down-delivery-retention.json` uses the maintained
mutation runner and the shipped `down` and `stopDelivery` composition. The
process-stop boundary is mocked before importing those functions. Credential
keys and deletion use the real workspace filesystem store. No process is
started, signalled or probed. The original `clean` assertion remains unchanged.

The first target restores the early delivery cleanup call and must fail
`DR01-broker-refusal-retains-both-delivery-credentials`. DR03 observes the same
ordering before the broker stop, but a DR01 failure stops the suite first.
No independent DR03 kill is claimed. The second target omits successful
whole-stack cleanup and must fail `DR07-whole-stack-cleans-only-after-broker-stop`.

Every command performs the normal build before the fourteen-cell suite.
Every `afterRestore` rebuilds restored source and reruns the full suite.
The distinct `COTAL_DOWN_RETENTION_TERMINAL` marker is printed after every
existing finally cleanup action completes, on success or a named assertion
failure. The original assertion error still propagates. If cleanup throws,
the marker is absent and the mutation result remains inconclusive. The
success-only smoke sentinel and all fourteen predicates remain unchanged.
Compilation or module-mock import failure without the named assertion is not
a kill. Node module-mock and tsx binding compatibility has not been executed.

Admission, baseline green, named kills and restored green are unexecuted.
Source review cannot supply these results. The runner must admit the commands
under its unchanged safety contract before execution. The original physical
`clean` fixture and all Endpoint live-proof holds remain separate. No rename,
wrapper, copied cleanup algorithm or safety-policy bypass is introduced.
