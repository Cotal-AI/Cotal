---
"@cotal-ai/connector-hermes": patch
---

A spawned Hermes seat on the managed profile now refuses to launch when no model was resolved.
The managed profile is a temporary directory and does not read `~/.hermes`, so a model configured
there is not used, and with no `--model`, no agent file `model:` and no ambient `HERMES_MODEL` the
generated `config.yaml` carried no `model:` key at all. Hermes then chose a default of its own over
a provider the operator may hold no key for. The seat still joined the mesh and still accepted a
turn, so the first sign of it was a provider authentication error partway through that turn, whose
advice pointed at the operator's own credentials.

The refusal names the three inputs that set a model and `COTAL_HERMES_ADOPT_HOME` for running on
the operator's own profile instead. It fires before the profile directory or the plugin is written, so a refused launch
leaves nothing on disk, and it prints as one line rather than a stack. A launch with a model is unchanged.

Refs #1715
