---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

The CLI reference now documents what a feedback intake expects: a `--key-file` holds one opaque bearer token with at most one final newline, a Cotal intake accepts reports only at `POST /v1/feedback` so `--url` names that path, and the `feedback-intake` service preset's `--keys` file is JSON in the form `{"keys":[{"key":"<token>","tester":"<tester-id>","name":"<display-name>"}]}`, with `name` optional.
