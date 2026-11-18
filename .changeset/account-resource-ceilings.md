---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
---
Operators can configure native data-account resource ceilings in config.json.

The optional accountLimits setting controls connections, subscriptions, payload bytes, JetStream memory and disk storage, and consumer count at authenticated broker startup. Invalid values are refused with the key named. Omitted settings retain existing limits. The security reference states the unlimited defaults.
