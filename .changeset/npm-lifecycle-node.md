---
"@cotal-ai/cli": patch
---

Self-update and extension installs can run npm lifecycle scripts when Node has a versioned executable name. On Linux and macOS, Cotal puts a private `node` link to the selected runtime on npm's PATH when needed.
