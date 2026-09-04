---
"cotal-ai": patch
---

Smoke suites launch the CLI through the workspace `node_modules/.bin/tsx` instead of `npx tsx`. From a scratch working directory `npx` resolves `tsx` from the npm cache or the registry rather than the workspace, and the registry install banner lands in the output the suites parse. A guard reddens on any suite that reintroduces the `npx tsx` form.
