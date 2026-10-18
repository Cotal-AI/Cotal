---
"@cotal-ai/core": patch
---

New `@cotal-ai/core/browser` entry for enforcing Manager command contracts in a page under a strict Content-Security-Policy. It imports no Node built-in or transport-node and never generates code at runtime. Its validators are generated at build time from the packaged Manager releases, using the same schema profile and Ajv options as `compileContract`. `packagedServiceSurface` assembles a described service's commands the way `resolveService` does, and any cluster or closure digest the build did not package is refused as `unsupported-version`. `standaloneContractSource` and the `gen:browser-contracts` script produce the validators. The entry opens no connection and acquires no authority.
