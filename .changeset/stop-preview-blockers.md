---
"@cotal-ai/cli": patch
---

The dry run of a stop of the stack's broker, as `down stack-broker --dry-run` or
`service stop stack-broker --dry-run`, now warns with the refusal the real stop gives while another
service instance of the space is live or a legacy daemon record under the root may front a process.
That refusal's Next names `cotal service stop <name> --instance <id> --space <space> --yes` for
each instance instead of a `<name>` placeholder. On a stopped stack, `down --dry-run --with-agents`
still shows the no-op and now warns that the real `--with-agents` stop refuses.
