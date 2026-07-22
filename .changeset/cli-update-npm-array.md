---
"@cotal-ai/cli": patch
---

fix(cli): accept npm's array-form version output in `cotal update`

`cotal update`'s "is a newer binary available" check parsed `npm view cotal-ai@latest version --json` as a bare JSON string. Real npm only returns a bare string while the registry holds a single published version; once more than one version exists it wraps the field in a JSON array (`["0.13.2"]`) even for the `@latest` tag. The strict string check then failed with `npm returned an invalid cotal-ai version`, so the whole command errored at the final step on every real install. The parser now accepts both the string and array forms and takes the highest valid semver, and still rejects empty/garbage output loudly.
