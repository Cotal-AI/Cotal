"""Cotal plugin for Hermes — joins the gateway to the Cotal mesh.

Registers three things on the Hermes plugin context:
  - a **gateway platform adapter** (``cotal``) — inbound wake/drive + outbound reply routing,
  - **lifecycle hooks** → Cotal presence (over connector-core's control socket),
  - the **cotal_* tools** — proactive mesh actions for the agent (full shared parity).

All three talk to the TS sidecar (which owns the mesh endpoint) over the sockets the launcher set
in the environment. Two run modes:
  - **Managed** — the Cotal launcher spawns this gateway with COTAL_BRIDGE_SOCKET (and the control
    socket + tools file) already set; we just register against them.
  - **Standalone** — a user's own ``hermes`` with the plugin installed: COTAL_SPACE / COTAL_NAME /
    COTAL_SERVERS are set but no bridge socket, so we spawn the bundled sidecar ourselves, derive
    the socket/file paths, and register against those.
"""
from __future__ import annotations

import os
import secrets
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from . import hooks
from .tools import register_tools


def _is_managed() -> bool:
    """Managed launches preset the bridge socket; its presence means the sidecar already exists."""
    return bool(os.environ.get("COTAL_BRIDGE_SOCKET"))


def _have_identity() -> bool:
    """Mirror core's hasIdentity: a name, a join link, or an agent file is the explicit opt-in.
    A COTAL_LINK (cotal://token@host/space) carries space + server + auth on its own, so a peer
    can join with just the link (+ an optional COTAL_NAME)."""
    return bool(
        os.environ.get("COTAL_NAME")
        or os.environ.get("COTAL_LINK")
        or os.environ.get("COTAL_AGENT_FILE")
    )


def _check_requirements() -> bool:
    """Enable the cotal platform when we can reach (or bootstrap) a sidecar: a preset bridge socket
    (managed) or enough identity to spawn one (standalone)."""
    return _is_managed() or _have_identity()


def _resolve_sidecar_js() -> Path:
    """Locate the bundled standalone sidecar (esbuild → cotal/_sidecar/standalone.cjs). Honors an
    explicit COTAL_SIDECAR_JS override; otherwise resolves it relative to THIS plugin dir. The
    bundle ships inside the plugin dir on purpose, so it travels with the plugin in every layout
    (monorepo, managed copy into HERMES_HOME, `hermes plugins install`, npm). Throws if absent —
    no silent fallback."""
    override = os.environ.get("COTAL_SIDECAR_JS")
    if override:
        p = Path(override)
        if not p.is_file():
            raise RuntimeError(f"COTAL_SIDECAR_JS={override} does not exist")
        return p
    candidate = Path(__file__).resolve().parent / "_sidecar" / "standalone.cjs"
    if not candidate.is_file():
        raise RuntimeError(
            f"bundled sidecar not found at {candidate} — build the connector (pnpm build) or set "
            "COTAL_SIDECAR_JS"
        )
    return candidate


def _resolve_node() -> str:
    """Locate a Node runtime for the sidecar. Prefer `node` on PATH (the gateway's PATH includes
    Hermes' bundled Node and the container has its own); else fall back to Hermes' bundled
    `<HERMES_HOME>/node/bin/node` (the host installer puts it there). Throws if neither exists —
    a bare `pip install hermes-agent` without `install.sh --postinstall` may have no Node."""
    on_path = shutil.which("node")
    if on_path:
        return on_path
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    bundled = Path(home) / "node" / "bin" / "node"
    if bundled.is_file():
        return str(bundled)
    raise RuntimeError(
        f"Node.js not found for the Cotal sidecar: no `node` on PATH and none at {bundled}. "
        "Install Node (Hermes' installer bundles it: `install.sh --ensure node`)."
    )


def _bootstrap_standalone_sidecar() -> None:
    """Standalone mode: spawn the bundled Node sidecar and wait until it has published the bridge
    socket + tools file. Sets the three path env vars first so the sidecar and the rest of this
    registration agree on them."""
    run_dir = Path(tempfile.mkdtemp(prefix="cotal-hermes-"))
    # Identity may come entirely from COTAL_LINK (which carries the space), so neither of these is
    # guaranteed — they're only used for the readiness error below.
    name = os.environ.get("COTAL_NAME") or "hermes"
    space = os.environ.get("COTAL_SPACE") or "(from COTAL_LINK)"
    os.environ.setdefault("COTAL_BRIDGE_SOCKET", str(run_dir / "bridge.sock"))
    os.environ.setdefault("COTAL_CONTROL_SOCKET", str(run_dir / "control.sock"))
    # The sidecar (listener) and the lifecycle hooks (this process) authenticate the control plane
    # with a shared first-frame token. Managed mode gets it from the launcher; standalone mints one
    # here so both sides — they share this env — agree on it.
    os.environ.setdefault("COTAL_CONTROL_TOKEN", secrets.token_urlsafe(32))
    os.environ.setdefault("COTAL_TOOLS_FILE", str(run_dir / "cotal-tools.json"))

    sidecar = _resolve_sidecar_js()
    node = _resolve_node()
    env = os.environ.copy()
    # Tie the sidecar's life to THIS process (the gateway that loaded the plugin). The official
    # container image boots the gateway twice — a transient CMD `gateway run` spawns a sidecar then
    # hands off to the supervised service — so a sidecar must follow its own launcher, not a ppid
    # that can be reparented before the sidecar ever reads it. The sidecar watches this exact pid.
    env["COTAL_PARENT_PID"] = str(os.getpid())
    subprocess.Popen(  # noqa: S603 — trusted bundled asset
        [node, str(sidecar)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Wait for the sidecar to be ready (tools file written + bridge socket bound). Fail loudly.
    tools_file = Path(os.environ["COTAL_TOOLS_FILE"])
    bridge_sock = Path(os.environ["COTAL_BRIDGE_SOCKET"])
    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        if tools_file.is_file() and bridge_sock.exists():
            return
        time.sleep(0.1)
    raise RuntimeError(
        f"cotal sidecar did not come up within 20s for {name}@{space} "
        f"(tools={tools_file.is_file()}, bridge={bridge_sock.exists()})"
    )


def register(ctx: Any) -> None:
    if not _is_managed():
        if not _have_identity():
            return  # not a cotal gateway — nothing to wire up
        _bootstrap_standalone_sidecar()

    # Gateway platform adapter (imported lazily so a non-gateway context still loads tools/hooks).
    from .adapter import CotalAdapter

    # Cotal mesh peers are already authorized by the NATS JWT, and an autonomous gateway has no
    # operator to approve a pairing code or pick a home channel — both are first-contact gateway
    # prompts that would otherwise intercept a peer's first message. Suppress them for the cotal
    # platform ONLY (per-platform allow-all + a sentinel home channel), so a standalone user's
    # other platforms (Telegram, …) keep their own access control.
    os.environ.setdefault("COTAL_ALLOW_ALL_USERS", "true")
    os.environ.setdefault("COTAL_HOME_CHANNEL", "mesh")

    ctx.register_platform(
        name="cotal",
        label="Cotal",
        adapter_factory=lambda cfg: CotalAdapter(cfg),
        check_fn=_check_requirements,
        allowed_users_env="COTAL_ALLOWED_USERS",
        allow_all_env="COTAL_ALLOW_ALL_USERS",
        platform_hint=(
            "You are coordinating with peer agents on the Cotal mesh. Your reply is delivered "
            "automatically back to whoever messaged you; use cotal_* tools only to reach OTHER "
            "peers/channels or report status."
        ),
        emoji="🔗",
        max_message_length=8000,
    )

    # Lifecycle hooks → presence.
    ctx.register_hook("on_session_start", hooks.on_session_start)
    ctx.register_hook("pre_llm_call", hooks.pre_llm_call)
    ctx.register_hook("pre_tool_call", hooks.pre_tool_call)
    ctx.register_hook("post_llm_call", hooks.post_llm_call)
    ctx.register_hook("on_session_end", hooks.on_session_end)

    # Proactive mesh tools (declared from the descriptors the sidecar wrote to COTAL_TOOLS_FILE).
    register_tools(ctx)
