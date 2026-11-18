/**
 * Fleet tailnet identities (GET /api/tailnet/peers). Module-level cache —
 * the map changes on the order of minutes, components fetch it freely.
 */
export interface TailnetPeer {
  ip: string;
  name: string;
  dnsName: string | null;
  online: boolean | null;
}

let cache: { peers: TailnetPeer[]; at: number } | null = null;
let inFlight: Promise<TailnetPeer[]> | null = null;
const TTL_MS = 60_000;

export async function fetchTailnetPeers(force = false): Promise<TailnetPeer[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.peers;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch("/api/tailnet/peers", { credentials: "same-origin" });
      if (!res.ok) throw new Error(`tailnet peers: ${res.status}`);
      const body = (await res.json()) as { peers?: TailnetPeer[] };
      cache = { peers: Array.isArray(body.peers) ? body.peers : [], at: Date.now() };
      return cache.peers;
    } catch {
      return cache?.peers ?? [];
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Hostname inside a helper URL, or "" when unparseable. */
export function safeUrlHost(url: string | undefined | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function normalizeTailnetHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "");
}

/** Resolve any host form (ip, machine name, dnsName, short dns) to a peer. */
export function resolveTailnetHost(host: string | undefined | null, peers: TailnetPeer[]): TailnetPeer | null {
  if (!host) return null;
  const want = normalizeTailnetHost(String(host));
  return (
    peers.find((p) => p.ip === want || p.name.toLowerCase() === want || p.dnsName?.toLowerCase() === want) ??
    peers.find((p) => p.dnsName?.toLowerCase().split(".")[0] === want) ??
    null
  );
}

/** Display name for a host: tailnet name when known, raw host otherwise. */
export function tailnetDisplayName(host: string | undefined | null, peers: TailnetPeer[]): string | null {
  if (!host) return null;
  return resolveTailnetHost(host, peers)?.name ?? String(host);
}
