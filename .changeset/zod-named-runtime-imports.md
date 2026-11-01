---
"@cotal-ai/connector-core": patch
---

Import the zod members the tool specs and gateway use by name, so bundles of those two modules no longer reach zod's locale tables through their own `z` namespace import. Tool schemas, tool names and descriptions, argument validation, and error messages are unchanged. Carriers that import zod elsewhere keep their own references.
