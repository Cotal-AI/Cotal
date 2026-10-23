---
"@cotal-ai/cli": patch
---

`status --components` no longer fails a healthy stack because the optional web dashboard is not
installed. With no dashboard extension and no dashboard process record, the web row reads
`not-installed · optional` and exits `0`. An installed dashboard that is not running still reads
`absent` and exits `1`.
