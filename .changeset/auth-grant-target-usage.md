---
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Make the auth commands agree with each other and classify their refusals.

- `cotal actor list`, `grant` and `revoke` now resolve their space and root as `cotal auth grants`, `grant` and `revoke` do. With no space to resolve they refuse with `TARGET_NOT_FOUND` instead of assuming `main`, and on a root without the space's user-auth ledger `actor list` refuses with `UNSUPPORTED` instead of reporting no rows.
- Grant usage is checked before any space or authority is read, under both spellings. A grant or revoke missing `--sub` or `--owner`, or a grant missing an ACL flag without `--full`, refuses with `USAGE_INVALID` (exit 1) and names every missing input in one refusal, where `actor grant` used to end with exit 5 and `auth grant` named one input per run. `actor` also refuses a flag that does not belong to its verb, as `auth` does.
- `cotal login` against a provider that cannot be reached or stops answering refuses with `DEPENDENCY_UNAVAILABLE` (exit 2) and a `--idp` remedy, instead of printing the raw transport error with exit 1. No session is cached.
- `cotal doctor auth` reports every credential with no expiry claim as a finding, including an agent credential that `cotal auth mint` wrote without `--expires-in` or `--expires-at`, so that root no longer reads as having no findings. The mint default is unchanged.
