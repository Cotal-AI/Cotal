---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
---
Operators can configure native data-account resource ceilings in config.json.

The optional operator-only accountLimits setting controls connections, subscriptions, payload bytes, JetStream memory and disk storage, and consumer count at authenticated broker startup. Project declarations are refused with the file and key named. Connections, subscriptions and payloads are bounded to 2147483647, while JetStream fields accept positive safe integers. Invalid values are refused with the specific key named. Omitted settings retain existing limits. Successful re-signing names the changed limits. Startup policy loading does not validate unrelated launch sections.

Core adds the public AccountLimits type, assertAccountLimits validator, applyAccountLimits re-signing API and loadAccountLimits policy reader. createSpaceAuth and createSpaceAccountAuth accept an optional limits parameter. The embedding exports reference documents these APIs, and the security reference states the unlimited defaults.
