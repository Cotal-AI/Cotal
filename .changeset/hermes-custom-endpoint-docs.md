---
"@cotal-ai/connector-hermes": patch
---

`docs/connect-hermes.md` now documents how a Hermes seat reaches a custom OpenAI-compatible endpoint. A seat does not inherit the endpoint variables from your shell, and Hermes 0.19 reads `CUSTOM_BASE_URL` only when its provider is `custom`, so a managed profile needs `HERMES_INFERENCE_PROVIDER=custom` and `CUSTOM_BASE_URL` exported and listed in `spawn.env`. An endpoint that needs a key belongs in an adopted profile's `config.yaml` model block. The page also says that `--model custom:<model>` is passed to Hermes unchanged and does not select the provider.
