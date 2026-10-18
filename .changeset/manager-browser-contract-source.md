---
"@cotal-ai/manager": patch
---

`@cotal-ai/manager` now exports `managerBrowserContractSource()`, the manager's registered cluster document with its closure digest and each distinct schema root. A host passes it to `generateBrowserContracts` from `@cotal-ai/core/browser-validators-build` to build the manager's browser validators. Before, the root exported only the document and digests, so no supported import carried the schema roots. Served commands, digests, wire, auth and runtime behavior are unchanged.
