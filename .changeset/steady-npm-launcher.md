---
"cotal-ai": minor
"@cotal-ai/cli": patch
---

Keep the installed cotal launcher available while npm replaces the CLI package.

The install script creates a launcher outside npm's replaced files. It retries only failed
module loading, in a fresh process, for up to two minutes and never replays a running command.
Global installations now require install scripts to create the cotal command. The package's
npm-owned binary is named cotal-ai so npm does not retire the stable cotal launcher on later
upgrades. The first upgrade from an older release still uses that release's old entry.
Use a pinned npm install for that first upgrade, since older self-updaters cannot verify the
new executable layout.
