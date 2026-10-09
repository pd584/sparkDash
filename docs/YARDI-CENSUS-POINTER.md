# Yardi endpoint census pointer (2026-10-09)

Any sparkDash-style board fed from Yardi should use the bridge REST surface,
not scraping. The authoritative endpoint census (1291 verbs tiered
read/suspected-write/state-changing/destructive), the report-engine protocol,
and the verified report/savedfilter bridge surface live in:

- `igor:/opt/data/profiles/nexus/workspace/YARDI-DANGER-MAP-2026-10-09.md`
  (human map; C/D tiers are never-fired loaded guns — do not exercise)
- `igor:/opt/data/profiles/nexus/workspace/yardi-write-surface-map.json`
  (machine-readable, all 1291 rows)
- mdc-one repo `docs/YARDI-BRIDGE-REPORT-SURFACE-2026-10-09.md`
  (the bridge surface boards should actually call:
  `/api/v1/reports/:name/meta|run`, `/api/v1/reports/private/*`,
  `/api/v1/saved-filters/*`; GPR batch-id quirk documented there)

Dashboard KPI aggregators (`genesisconnect/dashboard/*`, 105 observed live
endpoints in `yardi-breeze-endpoint-census.json`) map 1:1 to board tiles and
are all A-tier reads — mirrored without screen-scraping via the bridge's
raw passthroughs until typed tools land.
