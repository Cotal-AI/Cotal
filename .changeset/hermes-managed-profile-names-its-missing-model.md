---
"@cotal-ai/connector-hermes": patch
---

A spawned Hermes seat on the managed profile now says at launch when no model was resolved. The
managed profile is a temporary directory and does not read `~/.hermes`, so a model configured
there is not used, and with no `--model`, no agent file `model:` and no ambient `HERMES_MODEL` the
generated `config.yaml` carried no `model:` key at all. Hermes then chose a default of its own over
a provider the operator may hold no key for. The seat still joined the mesh and still accepted a
turn, so the first sign of it was a provider authentication error partway through that turn, whose
advice pointed at the operator's own credentials. Those credentials were usually fine, and their
model was configured in the profile this one never reads.

The warning names the three inputs that set a model and `COTAL_HERMES_ADOPT_HOME` for running on
the operator's own profile instead. Nothing else changes: the generated `config.yaml` is byte for
byte what it was, and a resolved model warns about nothing.

Refs #1715
