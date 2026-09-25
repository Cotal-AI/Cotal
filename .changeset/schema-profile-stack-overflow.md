---
"@cotal-ai/core": patch
---

Name the compiler's generated-code shape and the overflowing property count when a wide but legal contract schema overflows the call stack at compile, instead of blaming the caller's schema. Flip the schema-profile Ajv pin to `allErrors: true`, which raises the stack-bounded compile ceiling roughly 3.4x at any given stack budget without changing any validation verdict.
