/**
 * Say which provider is actually carrying a seat's model.
 *
 * The connector already refuses to join under a model label it did not receive, and that guarantee
 * stopped at the model. A seat could be truthfully labelled with the model an operator asked for
 * while its traffic was carried by a component nobody named: one seat was requested as a given
 * model, logged every line under a different provider's name, and died inside a third component's
 * plugin. Nothing in the roster, the spawn confirmation, or the manager's exit line named the route,
 * so establishing it meant reading the seat's private log by hand (#785).
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

/**
 * One line naming the effective route for `model`.
 *
 * The route matching the requested model wins, because `runtime.provider` is the session default and
 * can differ from the provider actually serving this model. When neither is known the line says so
 * explicitly rather than guessing or going quiet: an unknown route is itself worth reporting, since
 * silence is what made this expensive to diagnose.
 */
export function describeRoute(runtime: RuntimeIdentity | undefined, model: string): string {
  const matched = runtime?.routes?.find((r) => r?.model === model);
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
