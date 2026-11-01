/** Approve a pending device login as the signed-in IdP user, the way a human at the verification
 *  page does: claim the user code, then approve it. Both answers must be 2xx, so an approval that
 *  fails rejects here instead of leaving the login to wait out the device code.
 *
 *  Hand the promise to the login: `onPrompt: (p) => approve(p.userCode)`. `deviceLogin` awaits
 *  `onPrompt` before it polls and fails the login when it rejects, so the step that needed the
 *  approval is the step that fails. `void approve(...)` dropped that rejection, and Node then ended
 *  the whole process on it, outside any cell (#3012).
 *
 *  The one copy for every smoke and acceptance suite that signs a user in against a Better Auth
 *  fixture. Not shipped and not imported by shipped code: this file lives under `smoke/`. */
export interface DeviceApprover {
  /** The IdP auth base URL (Better Auth: `<origin>/api/auth`). */
  base: string;
  /** The signed-in user's session cookie, `name=value`. */
  cookie: string;
  /** The IdP origin, sent as `Origin` as the verification page's own requests carry it. */
  origin: string;
}

export async function approveDevice(idp: DeviceApprover, userCode: string): Promise<void> {
  const headers = { cookie: idp.cookie, origin: idp.origin };
  const claim = await fetch(`${idp.base}/device?user_code=${encodeURIComponent(userCode)}`, { headers });
  if (!claim.ok) throw new Error(`device claim failed: HTTP ${claim.status}`);
  const res = await fetch(`${idp.base}/device/approve`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ userCode }),
  });
  if (!res.ok) throw new Error(`device/approve failed: HTTP ${res.status}`);
}
