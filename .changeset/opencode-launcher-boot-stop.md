---
"@cotal-ai/connector-opencode": patch
---

The OpenCode launcher now stops its server on SIGINT or SIGTERM from the moment it starts it. The handler used to be installed only after the plugin's session handshake, so a graceful stop during the boot, which can take a minute on a cold server, ended the launcher and left the server running on the agent's database, with a `serve.pid` record that refused every later launch of that name until the server was killed by hand. One handler now stops the server and, once it runs, the TUI.
