/**
 * Fleet-wide tailnet identity resolver.
 *
 * Session/harness surfaces know endpoints (ip:host), not machines. The
 * tailnet has the naming: `tailscale status --json` on any tailnet member
 * yields the full peer map (ip -> machine name / dnsName). We run it once
 * through the first spark whose ssh works, memoize the winner, and refresh
 * on a slow TTL. Reuses LlmClientsProbe's parser so naming stays identical
 * to the per-port client chips.
 */
import { sshExec } from "../collectors/ssh.js";
import { peerMapFromStatus } from "../collectors/LlmClientsProbe.js";

const TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 8_000;

export function createTailnetPeersService({ listSparks }) {
  /** @type {{ peers: object[], byHost: Map<string, {name: string, dnsName: string|null, ip: string}>, at: number } | null} */
  let cache = null;
  let preferredSparkId = null;
  let inFlight = null;

  function build(raw) {
    const map = peerMapFromStatus(raw);
    const peers = [];
    const byHost = new Map();
    for (const [ip, info] of map.entries()) {
      peers.push({ ip, name: info.name, dnsName: info.dnsName, online: info.online });
      const entry = { name: info.name, dnsName: info.dnsName, ip };
      if (!byHost.has(ip)) byHost.set(ip, entry);
      if (info.name && !byHost.has(info.name.toLowerCase())) byHost.set(info.name.toLowerCase(), entry);
      if (info.dnsName && !byHost.has(info.dnsName.toLowerCase())) {
        byHost.set(info.dnsName.toLowerCase(), entry);
        const short = info.dnsName.toLowerCase().split(".")[0];
        if (!byHost.has(short)) byHost.set(short, entry);
      }
    }
    peers.sort((a, b) => a.name.localeCompare(b.name) || a.ip.localeCompare(b.ip));
    return { peers, byHost, at: Date.now() };
  }

  async function refresh(force = false) {
    if (!force && cache && Date.now() - cache.at < TTL_MS) return cache;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const sparks = (typeof listSparks === "function" ? listSparks() : []).filter(
          (s) => s?.ssh?.host
        );
        const ordered = preferredSparkId
          ? [...sparks.filter((s) => s.id === preferredSparkId), ...sparks.filter((s) => s.id !== preferredSparkId)]
          : sparks;
        for (const spark of ordered) {
          try {
            const out = await Promise.race([
              sshExec(spark, "tailscale status --json"),
              new Promise((_r, rej) => setTimeout(() => rej(new Error("tailnet probe timeout")), PROBE_TIMEOUT_MS)),
            ]);
            const raw = JSON.parse(out);
            if (!raw?.Self && !raw?.Peer) continue;
            preferredSparkId = spark.id;
            cache = build(raw);
            return cache;
          } catch {
            /* next spark */
          }
        }
        return cache; // stale beats nothing
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /** Resolve any host form (tailnet ip, name, dnsName, short dns) to tailnet identity. */
  async function resolve(host) {
    if (!host) return null;
    const want = String(host).toLowerCase().replace(/^\[|\]$/g, "");
    const state = (cache && Date.now() - cache.at < TTL_MS ? cache : null) || (await refresh());
    if (!state) return null;
    return state.byHost.get(want) ?? state.byHost.get(want.split(".")[0]) ?? null;
  }

  return { refresh, resolve };
}
