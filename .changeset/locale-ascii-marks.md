---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Under a locale whose character set is not UTF-8, such as `LANG=C`, `POSIX` or ISO-8859-1, reports,
refusals and usage errors now write their marks and punctuation in ASCII, as `--plain` does, and
keep their color. With no locale variable set, the marks stay UTF-8.
