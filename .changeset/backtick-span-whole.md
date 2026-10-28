---
"@cotal-ai/workspace": patch
---

Anything a line writes in backticks now wraps as one word on a terminal, whatever it starts with. At 80 columns the Next of `cotal daemon install --dry-run`, where no user manager answers, broke `` `systemctl --user show-environment` `` after `--user`; only a span that started with `cotal`, `pnpm`, `npx` or `cd` was kept whole, and only after other words. A span wider than the line keeps a line of its own, as a command does. A line that starts with a command outside backticks, such as a usage line, still wraps at its spaces.
