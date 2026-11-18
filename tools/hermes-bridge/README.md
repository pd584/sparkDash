# hermes occupancy bridge

Serves the sparkDash helper contract from the gateway routing index
(`gateway_routing` in the shared `state.db`).

    python3 server.py            # BRIDGE_BIND/BRIDGE_PORT overridable

Deployment on igor (systemd user unit, LAN bind):

    systemctl --user enable --now sparkdash-hermes-bridge

The dashboard must allowlist the host: `SPARKDASH_HELPER_HOSTS=<bind-ip>`
on the sparkDash container, then register the helper (wizard or
`PUT /api/occupancy/helpers`) with url `http://<bind-ip>:8124` and a
route hermes -> <spark>:<llm-port>. Sessions carry no native origin —
route attribution is `configured-route` by design; the bridge never
fabricates endpoint provenance.
