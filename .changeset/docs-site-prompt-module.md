---
---

The docs site sync now imports the setup prompt and its Quickstart fence from one plain JavaScript module (`website/src/prompt.js`) that the site pages also import. It used to pull the prompt out of `prompt.ts` with a regex that only read a single-quoted literal without an apostrophe, so an escaped apostrophe or a template literal made the sync fail and blame the Quickstart page. This touches the `website/` project only; no published package changes.
