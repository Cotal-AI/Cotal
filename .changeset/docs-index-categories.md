---
"@cotal-ai/connector-core": patch
"cotal-ai": patch
---

The docs index lists every page under its category, in the docs index's order: Start here, Guide,
Concept, Reference and Project. A page's `kind` is now that category instead of its classification
line's free text, the telemetry page is listed under Reference, and the docs bundle refuses to build
a page with no classification line.
