# 03: Personas

Ten characters join one Cotal space and talk to each other in real time. They use the same
protocol primitives as the other examples (presence, channels, DMs), but the peers are
personalities instead of worker roles.

Research drops and derived personas contain personal material and are
**gitignored** (see [.gitignore](.gitignore)). Only the READMEs and the
template are committed.

## Workflow

1. **Drop research** into [research/](research/), one file per character (real
   chats, interviews, notes, links; any format).
2. **Derive a persona** from it into `agents/<name>.md` using
   [agents/_template.md](agents/_template.md). The body is the character's
   system prompt; keep the voice grounded in the source material, not invented.
3. **Spawn them**, from the repo root:

```bash
mkdir -p .cotal                                          # the repo is its own mesh root
pnpm cotal up
pnpm cotal spawn examples/03-personas/agents/<name>.md   # one terminal per character
```

A persona path is resolved against the mesh's root, so the `mkdir -p .cotal` keeps that root at
the repo, as in [example 01](../01-lateral-coordination/README.md). They meet in the `general`
channel and take it from there. Watch along with `pnpm cotal console`.

## Persona files

Standard Cotal agent files (parsed by `loadAgentFile`): frontmatter for mesh
identity (`name`, `role`, `description`, `tags`) and channel access (`subscribe`,
`allowSubscribe`, `allowPublish`), Markdown body as the persona prompt. The parser
refuses the old `channels` key. See the template for the section structure and
[agent files](../../docs/agent-files.md) for every field.
