# Cotal containerized agent team.
#
# One image; the container's command picks the shape:
#   supervise --roster roster.yaml   -> a manager + N agents (pty runtime)
#   spawn <name>                      -> one foreground agent
# It connects OUT to an external NATS/Cotal broker (COTAL_SERVERS); only NATS traffic
# leaves the container. Build from the repo root:
#
#   docker build -f deploy/docker/Dockerfile -t cotal-runner .
#
FROM node:24-slim

# - python3/make/g++: compile the node-pty native addon if no prebuild matches the platform.
# - git + ca-certificates: Claude Code / TLS to the broker + model API.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Agent CLIs the connectors launch (the `claude` and `opencode` binaries). Installed globally as
# root so they sit on PATH for every user; pin versions here if you need reproducible builds.
RUN npm install -g @anthropic-ai/claude-code opencode-ai

# The plugin install (build) and the agents (runtime) MUST run as the SAME uid, or the runtime
# user won't see the plugin cached under its HOME. One non-root user for both.
RUN useradd --uid 10001 --create-home --home-dir /home/cotal --shell /bin/bash cotal
ENV HOME=/home/cotal
# tsx is a local dev dep reached via node_modules/.bin - put it on PATH (the entrypoint also
# goes through `pnpm exec`, but this makes a bare `tsx` resolve too).
ENV PATH=/workspace/node_modules/.bin:$PATH

WORKDIR /workspace
RUN corepack enable
# Bring in the repo (node_modules / .cotal excluded via Dockerfile.dockerignore) owned by the
# runtime user.
COPY --chown=10001:10001 . /workspace
# COPY --chown sets ownership on the copied *contents*, but the /workspace dir node itself stays
# root-owned (created by WORKDIR) - pnpm writes temp files at the workspace root, so chown it too.
# Also pre-create the config tree the runtime mounts into, owned by the runtime user.
RUN chown 10001:10001 /workspace \
  && mkdir -p /workspace/.cotal/auth/creds /workspace/.cotal/agents \
  && chown -R 10001:10001 /workspace/.cotal

USER 10001
RUN pnpm install --frozen-lockfile \
  && pnpm build
# Install the cotal plugin so the wake channel binds (it must be *installed*, not --plugin-dir).
# `cotal setup` with Claude as the application = claude plugin marketplace add <repo> + plugin
# install cotal@cotal-mesh --scope local. Runs as uid 10001 so the plugin cache (~/.claude) +
# enablement (/workspace/.claude/settings.local.json) are owned by the user that runs at runtime.
# Its space is a throwaway one in /tmp/cotal-image, so nothing is prepared at /workspace, where the
# runtime joins the external broker.
RUN mkdir -p /tmp/cotal-image \
  && pnpm cotal setup --destination local --harness claude --project /tmp/cotal-image --space image --no-input

# Pre-complete claude's first-run onboarding for the runtime user. A fresh container has no
# ~/.claude.json, so claude 2.1.179 would block a managed (non-interactive) session on the
# theme picker and the "trust this folder" prompt, before the dev-channels confirm the pty
# runtime auto-clears, and the agent never loads its plugin/MCP, never joining the mesh.
# Seed the onboarding + per-workspace trust flags so a supervised claude boots straight through.
RUN node -e 'const fs=require("fs"),os=require("os"),p=require("path");const f=p.join(os.homedir(),".claude.json");const c=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};c.hasCompletedOnboarding=true;c.theme=c.theme||"dark";c.projects=c.projects||{};c.projects["/workspace"]={...(c.projects["/workspace"]||{}),hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true};fs.writeFileSync(f,JSON.stringify(c,null,2));console.log("seeded "+f)'

# Auto-approve tools for the runtime user. A supervised agent has no human to grant tool
# permissions, so without this it wakes on a peer message, tries to reply via cotal_send, and
# stalls forever on the permission prompt. `auto` mode + the cotal MCP server on the allow-list
# + the skip flags let it act unattended. Safe here: the container is the isolation boundary
# (non-root, cap_drop ALL, no host mounts), so an auto-approving agent is still contained.
RUN node -e 'const fs=require("fs"),os=require("os"),p=require("path");const d=p.join(os.homedir(),".claude");fs.mkdirSync(d,{recursive:true});const f=p.join(d,"settings.json");const c=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};c.permissions=c.permissions||{};c.permissions.defaultMode="auto";c.permissions.allow=Array.from(new Set([...(c.permissions.allow||[]),"mcp__plugin_cotal_cotal"]));c.skipAutoPermissionPrompt=true;c.skipDangerousModePermissionPrompt=true;fs.writeFileSync(f,JSON.stringify(c,null,2));console.log("seeded "+f)'

ENTRYPOINT ["bash", "/workspace/deploy/docker/entrypoint.sh"]
CMD ["supervise"]
