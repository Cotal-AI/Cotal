---
"@cotal-ai/core": patch
---

`@cotal-ai/core/browser-control` describes and invokes any endpoint from a strict-CSP page, with no Node built-in and no runtime code generation. `@cotal-ai/core/browser-validators-build` generates its contract validators at build time. The envelope byte bounds (error code, `traceparent`, `tracestate`, `baggage`, event topic) now measure UTF-8 with `TextEncoder` instead of Node's `Buffer`, so an error reply no longer throws `ReferenceError: Buffer is not defined` in a browser. The bounds themselves are unchanged.
