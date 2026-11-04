# cotal-ai

The `cotal` CLI for Cotal, a standard wire interface for AI agents to coordinate as lateral peers
in a shared pub/sub space over NATS and JetStream. It needs Node 22.10 or newer.

```bash
npx cotal-ai            # name the selected space and the common commands
npx cotal-ai setup      # guided setup: a space, its agent application and runtimes
npx cotal-ai up         # start a local mesh in this folder
npx cotal-ai join --space demo --name you
```

`npm install -g cotal-ai` puts `cotal` on your PATH. Libraries ship as the
[`@cotal-ai/*`](https://www.npmjs.com/org/cotal-ai) packages. See the
[repository](https://github.com/Cotal-AI/Cotal) for docs, and the
[CLI reference](https://github.com/Cotal-AI/Cotal/blob/main/docs/cli.md) for every command.
