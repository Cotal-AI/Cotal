/**
 * Say which provider is actually carrying a seat's model.
 *
 * A seat can be pinned to the model an operator asked for while its traffic is carried by a component
 * nobody named: one seat was requested as a given model, logged every line under a different
 * provider's name, and died inside a third component's plugin. Nothing in the roster, the spawn
 * confirmation, or the manager's exit line named the route, so establishing it meant reading the
 * seat's private log by hand (#785).
 *
 * `RuntimeInfo` carries `provider` and `routes` in the same response the model check already reads,
 * so this is a reporting gap, not a discovery problem.
 */

/** The route fields this description reads; a subset of the SDK's `ModelRouteInfo`. */
export interface RouteInfo {
  model: string;
  provider: string;
  api_method?: string;
  available?: boolean;
}

/** The subset of the SDK's `RuntimeInfo` needed to describe a route. */
export interface RuntimeIdentity {
  provider?: string;
  model?: string;
  providers?: string[];
  routes?: RouteInfo[];
}

/** The route serving `model`. RuntimeInfo's active provider disambiguates duplicate model ids. */
export function activeModelRoute(runtime: RuntimeIdentity | undefined, model: string): RouteInfo | undefined {
  const matches = runtime?.routes?.filter((route) => route?.model === model) ?? [];
  return matches.find((route) => route.provider === runtime?.provider) ?? (matches.length === 1 ? matches[0] : undefined);
}

/**
 * One line naming the effective route for `model`.
 *
 * The requested pin selects the model whose route is described. RuntimeInfo.model can lag behind a
 * successful setModel, while RuntimeInfo.provider identifies the active route among duplicate model
 * ids. When no matching route is known, the provider remains useful diagnostic context. When neither
 * is known the line says so explicitly rather than guessing or going quiet.
 */
export function describeRoute(runtime: RuntimeIdentity | undefined, model: string): string {
  const matched = activeModelRoute(runtime, model);
  const provider = matched?.provider ?? runtime?.provider;
  if (!provider) return `model ${model} is served by an unreported provider (the Harness API named none)`;
  const via = matched?.api_method ? ` via ${matched.api_method}` : "";
  const unavailable = matched && matched.available === false ? " (route reports itself UNAVAILABLE)" : "";
  return `model ${model} is served by provider ${provider}${via}${unavailable}`;
}

/**
 * Reject a `provider/model` specifier at the boundary instead of forwarding it.
 *
 * An operator passing `--model <provider>/<model>` had it sent verbatim to an endpoint that wants a
 * bare id, and the resulting `model_not_found` named neither the connector nor the prefix as the
 * cause. Returns the accepted form so the caller can say what to use instead.
 */
export function bareModelId(model: string): { ok: true } | { ok: false; bare: string; prefix: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return { ok: true };
  return { ok: false, bare: model.slice(slash + 1), prefix: model.slice(0, slash) };
}
