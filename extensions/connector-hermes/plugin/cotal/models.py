"""The models a Hermes seat can run, for the connector's catalog (src/models.ts).

Run under the project-pinned Hermes with the environment a launch builds. It asks Hermes's own
``resolve_runtime_provider`` which provider that environment picks, as the gateway does when it
starts an agent, then lists that provider's models: ``fetch_api_models`` for an OpenAI-compatible
endpoint (``custom``), ``provider_model_ids`` for a named provider. Prints one JSON line,
``{"provider", "models"}``, or ``{"unavailable"}`` with Hermes's reason. The three functions are
Hermes's own across the supported 0.18 to 0.21 range.
"""
from __future__ import annotations

import json


def catalog() -> dict:
    from hermes_cli.models import fetch_api_models, provider_model_ids
    from hermes_cli.runtime_provider import resolve_runtime_provider

    try:
        runtime = resolve_runtime_provider()
    except Exception as exc:
        return {"unavailable": f"Hermes resolves no model provider from the environment a launch receives, its provider keys and the spawn.env names: {exc}"}
    provider = str(runtime.get("provider") or "")
    if provider == "custom":
        ids = fetch_api_models(runtime.get("api_key"), runtime.get("base_url"), api_mode=runtime.get("api_mode"))
        if ids is None:
            return {"unavailable": "Hermes could not read the model list of the custom endpoint the launch environment names"}
    else:
        ids = provider_model_ids(provider)
    return {"provider": provider, "models": [str(i) for i in ids or [] if str(i)]}


if __name__ == "__main__":
    print(json.dumps(catalog()))
