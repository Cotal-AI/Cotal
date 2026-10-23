// Shared presence wording for the monitor and graph. The browser has no Node imports;
// presence-wording.smoke.ts checks these pure helpers against core's public exports.
(() => {
  function ageAt(now, at) {
    return typeof at === "number" && Number.isFinite(at) ? Math.max(0, now - at) : undefined;
  }
  function presenceAges(p, now) {
    return {
      conditionSince: ageAt(now, p.condition?.since),
      statusSince: ageAt(now, p.statusSince),
      activitySince: p.activity ? ageAt(now, p.activitySince) : undefined,
      activeAt: ageAt(now, p.activeAt),
    };
  }
  function formatAge(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }
  function presenceText(text) {
    const shown = Array.from(text, character => character.replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu,
      control => `\\u${control.charCodeAt(0).toString(16).padStart(4, "0")}`));
    if (shown.reduce((length, part) => length + [...part].length, 0) <= 200) return shown.join("");
    let kept = "", length = 0;
    for (const part of shown) {
      length += [...part].length;
      if (length > 199) break;
      kept += part;
    }
    return `${kept}…`;
  }
  function heartbeatAge(ts, now = Date.now()) {
    const age = ageAt(now, ts);
    return age === undefined ? undefined : formatAge(age);
  }
  function describe(p, now = Date.now()) {
    const age = presenceAges(p, now);
    const condition = p.condition ? ` (${presenceText(p.condition.code)}${age.conditionSince === undefined ? "" : ` for ${formatAge(age.conditionSince)}`})` : "";
    const unchanged = age.statusSince === undefined ? "" : ` · unchanged for ${formatAge(age.statusSince)}`;
    const active = age.activeAt === undefined ? "" : ` · active ${formatAge(age.activeAt)} ago`;
    const activityAge = age.activitySince === undefined ? "" : `set ${formatAge(age.activitySince)} ago`;
    const activity = p.activity ? presenceText(p.activity) + (activityAge ? ` (${activityAge})` : "") : "";
    const heartbeat = heartbeatAge(p.ts, now);
    const status = p.status === "working" && p.progress?.kind === "unknown" ? "working · progress unknown" : p.status;
    return { status: status + condition + unchanged + active, activity, activityAge,
      heartbeat: heartbeat === undefined ? "" : `heartbeat ${heartbeat} ago` };
  }
  window.COTAL_PRESENCE = { presenceAges, formatAge, heartbeatAge, describe };
})();
