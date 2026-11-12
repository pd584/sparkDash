/**
 * The dashboard's own availability topic lives outside the per-unit namespace
 * (`status/{id}`), so no Spark id — "dashboard" included — can collide with it.
 */
export function dashboardStatusTopic(prefix) {
  return `${prefix}/dashboard/status`;
}

/** Retained "1"/"0" availability for one unit; the id is percent-encoded. */
export function unitStatusTopic(prefix, sparkId) {
  return `${prefix}/status/${encodeURIComponent(sparkId)}`;
}

/** Retained metrics JSON for one unit; the id is percent-encoded. */
export function unitMetricsTopic(prefix, sparkId) {
  return `${prefix}/metrics/${encodeURIComponent(sparkId)}`;
}
