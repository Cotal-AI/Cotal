---
"@cotal-ai/connector-jcode": minor
---

`cotal models --harness jcode` now lists the models your Jcode can use, including on a default install with no `config.toml`. The catalog runs `jcode model list --json` and keeps each model that Jcode reports with an available route. It no longer reads `model_catalog` or `reasoning_efforts` from Jcode's `config.toml`, and it lists no effort variants, because Jcode reports none per model. `--variant` still sets the effort at launch, and a seat still stops before its first turn when Jcode rejects that effort.
