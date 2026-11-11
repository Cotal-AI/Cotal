---
"@cotal-ai/pi": patch
---

The pi connector now lists the models your own pi can run, so `models` and model pickers show them for pi.

The connector starts a short-lived `pi --mode rpc --no-session --offline` with the environment a launch gets, sends one `get_available_models` command, and stops pi. Each id is `provider/id`, the form pi's `--model` takes. When pi is missing, holds no provider credentials, refuses, answers with something unexpected or does not answer within 10 seconds, the catalog is reported unavailable with the reason.
