---
"@cotal-ai/cli": patch
---

A question that defaults to No, such as the one before `history clear`, `down`, `channel remove`,
`persona remove` or a reset, now confirms only on a typed `y` or `yes` and Enter. Enter alone or
any other text keeps No. The Yes and No toggle it replaced took stray text as Yes: `h`, `j`, `k`
and `l` moved its selection and a `y` inside a word submitted it, so typing "ok" and Enter cleared
history. Its title now breaks at spaces with each continuation line under the text, where the
toggle's wrap could move the break space onto the next line.
