# Comment history check

Source comments describe the current contract. `pnpm check:comment-history` checks tracked
JavaScript and TypeScript under package, implementation and extension `src/` trees, plus the
binary's source under `bin/`. It excludes declarations, tests, smoke suites, mutation fixtures,
built output, `bin/scripts/` and the private smoke helpers. It reads comments through TypeScript's
parser, so strings, regular expressions, template text and JSX text do not count. Comments inside
template substitutions and JSX expressions do count.

The rules match `#` followed by at least three digits and the phrases `used to`, `previously`,
`no longer` and `formerly`. Phrase matching is case insensitive and uses word boundaries.
Whitespace and a wrapped doc comment's leading star may separate the words of a phrase.
Each match counts once for its rule.

`scripts/comment-history-allowlist.json` records existing counts by file and rule. A check fails
when a file's count rises or the repository total for any rule rises. Diagnostics name the rule,
its old and new counts, and the receiving files. The line points to the file's first match for
that rule, not necessarily the added match. Decreases pass without rewriting the file.

## Moving source

Moving a comment between files preserves the repository total but increases the destination's
count. The check refuses that stale baseline and names the destination. After reviewing the move,
run one command and commit the resulting allowlist change:

```bash
pnpm check:comment-history:update
```

The command rewrites all file counts deterministically and records the checkout's HEAD in
`generatedAt`. The unchanged move then passes. An additional violation still fails until a human
explicitly accepts a changed baseline. Review baseline changes against source changes because the
update command can also accept newly added violations. Counts cannot distinguish replacement text
with the same number of matches for the same rule in the same file.

## Checking the checker

`pnpm check:comment-history` runs both the repository scan and fixture controls against an
unchanged copy of the checker in a temporary Git repository. The controls cover lexical contexts,
source inclusion, counts, repository totals, file moves, baseline regeneration and malformed
baselines. `pnpm check:docsbundle` runs this command beside `pnpm check:doc-comments`.
