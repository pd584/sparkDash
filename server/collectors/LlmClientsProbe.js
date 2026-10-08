/**
 * LlmClientsProbe — who is connected to each LLM listen port, and which of
 * those sockets is actually being served right now.
 *
 * vLLM / SGLang / EXL3 do not expose client IPs. Signal is TCP peers on the
 * listen port (`ss -Hti`), named from this node's `tailscale status --json`
 * Self+Peer map.
 *
 * Keep-alives and sparkDash's own probe always show as ESTAB. "Serving" is
 * gated on the engine being busy (tok/s / running requests) AND that peer
 * moving bytes or having a recent lastsnd/lastrcv. Idle sockets stay listed
 * as idle, not as the live client.
 */
import { TAILSCALE_PROBE_TIMEOUT_MS, HOST_PATHS } from "../config.js";
import { sshExec } from "./ssh.js";
import fs from "fs";
import path from "path";

const PEER_TTL_MS = 30_000;
const SPLIT_MARK = "__SPARKDASH_TS__";
const MAX_CLIENTS = 32;
/** lastsnd/lastrcv below this (ms) = tokens still on the wire, not a 2s scrape. */
const RECENT_MS = 400;
const ENGINE_TPS_BUSY = 0.5;
/** Keep a peer on the card this long after its last connection closes. */
const RECENT_DECAY_MS = 10 * 60_000;
/** Re-check which process owns the listen ports this often. */
const LISTEN_CHECK_MS = 60_000;

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function str(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

/**
 * @param {string} text
 * @param {RegExp} re
 * @returns {number | null}
 */
function matchNum(text, re) {
  const m = text.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Drop brackets and IPv4-mapped IPv6 so Tailscale CGNAT matches `ss`.
 * @param {unknown} ip
 * @returns {string | null}
 */
export function canonicalizeIp(ip) {
  if (ip == null) return null;
  let s = String(ip).trim();
  if (!s) return null;
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s.startsWith("::ffff:")) s = s.slice(7);
  if (s === "::1") return "127.0.0.1";
  return s;
}

/**
 * Split `addr:port` / `[ipv6]:port` from `ss`.
 * @param {string} addr
 * @returns {{ ip: string, port: number } | null}
 */
export function parseSsAddr(addr) {
  if (typeof addr !== "string" || !addr) return null;
  const s = addr.trim();
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 1) return null;
    const ip = canonicalizeIp(s.slice(1, close));
    const port = parseInt(s.slice(close + 2), 10);
    if (!ip || !Number.isInteger(port)) return null;
    return { ip, port };
  }
  const colon = s.lastIndexOf(":");
  if (colon < 1) return null;
  const ip = canonicalizeIp(s.slice(0, colon));
  const port = parseInt(s.slice(colon + 1), 10);
  if (!ip || !Number.isInteger(port)) return null;
  return { ip, port };
}

/**
 * Empty per-IP aggregate.
 * @returns {object}
 */
function emptyAgg() {
  return {
    connections: 0,
    recvQ: 0,
    sendQ: 0,
    lastSndMs: null,
    lastRcvMs: null,
    bytesSent: 0,
    bytesReceived: 0,
  };
}

/**
 * @param {string} text  `ss -Hti` (or `ss -Htn`) output
 * @param {number[]} listenPorts
 * @returns {Map<number, Map<string, object>>} port → ip → aggregate
 */
export function parseSsEstablished(text, listenPorts) {
  const anyPort = !Array.isArray(listenPorts) || listenPorts.length === 0;
  const ports = anyPort
    ? null
    : new Set(
        listenPorts
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535)
      );
  /** @type {Map<number, Map<string, ReturnType<typeof emptyAgg>>>} */
  const byPort = new Map();
  if (typeof text !== "string" || (!anyPort && ports.size === 0)) return byPort;

  const lines = text.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;
    const state = cols[0];
    if (state !== "ESTAB" && state !== "ESTABLISHED") continue;
    const recvQ = Number(cols[1]) || 0;
    const sendQ = Number(cols[2]) || 0;
    const local = parseSsAddr(cols[cols.length - 2]);
    const peer = parseSsAddr(cols[cols.length - 1]);
    if (!local || !peer) continue;
    if (!anyPort && !ports.has(local.port)) continue;

    let lastSndMs = null;
    let lastRcvMs = null;
    let bytesSent = 0;
    let bytesReceived = 0;
    const next = lines[i + 1];
    if (next != null && /^\s/.test(next)) {
      i += 1;
      const info = next;
      lastSndMs = matchNum(info, /\blastsnd:(\d+)/);
      lastRcvMs = matchNum(info, /\blastrcv:(\d+)/);
      bytesSent = matchNum(info, /\bbytes_sent:(\d+)/) ?? 0;
      bytesReceived = matchNum(info, /\bbytes_received:(\d+)/) ?? 0;
    }

    let ipMap = byPort.get(local.port);
    if (!ipMap) {
      ipMap = new Map();
      byPort.set(local.port, ipMap);
    }
    let agg = ipMap.get(peer.ip);
    if (!agg) {
      agg = emptyAgg();
      ipMap.set(peer.ip, agg);
    }
    agg.connections += 1;
    agg.recvQ += recvQ;
    agg.sendQ += sendQ;
    agg.bytesSent += bytesSent;
    agg.bytesReceived += bytesReceived;
    if (lastSndMs != null) {
      agg.lastSndMs = agg.lastSndMs == null ? lastSndMs : Math.min(agg.lastSndMs, lastSndMs);
    }
    if (lastRcvMs != null) {
      agg.lastRcvMs = agg.lastRcvMs == null ? lastRcvMs : Math.min(agg.lastRcvMs, lastRcvMs);
    }
  }
  return byPort;
}

/**
 * HostName keyed by every Tailscale IP on Self + Peer.
 * @param {object} raw  `tailscale status --json`
 * @returns {Map<string, { name: string, dnsName: string | null, online: boolean | null }>}
 */
export function peerMapFromStatus(raw) {
  /** @type {Map<string, { name: string, dnsName: string | null, online: boolean | null }>} */
  const map = new Map();
  const add = (node) => {
    if (!node || typeof node !== "object") return;
    const dns = str(node.DNSName)?.replace(/\.$/, "") ?? null;
    const name = str(node.HostName) || (dns ? dns.split(".")[0] : null);
    if (!name) return;
    const online = typeof node.Online === "boolean" ? node.Online : null;
    const addIp = (rawIp) => {
      const ip = canonicalizeIp(rawIp);
      if (ip && !map.has(ip)) map.set(ip, { name, dnsName: dns, online });
    };
    const ips = Array.isArray(node.TailscaleIPs) ? node.TailscaleIPs : [];
    for (const rawIp of ips) addIp(rawIp);
    const addrs = Array.isArray(node.Addrs) ? node.Addrs : [];
    for (const raw of addrs) {
      const parsed = parseSsAddr(String(raw));
      if (parsed) addIp(parsed.ip);
      else addIp(raw);
    }
    if (node.CurAddr) {
      const parsed = parseSsAddr(String(node.CurAddr));
      if (parsed) addIp(parsed.ip);
    }
  };
  add(raw?.Self);
  const peer = raw?.Peer;
  if (peer && typeof peer === "object") {
    for (const node of Object.values(peer)) add(node);
  }
  return map;
}

/**
 * @param {Map<number, Map<string, object>>} byPort
 * @param {Map<string, { name: string, dnsName: string | null, online: boolean | null }>} peerMap
 * @param {(port: number, ip: string, sent: number, recv: number) => number} [bytesPerSecFor]
 * @returns {Record<number, { clients: object[], error: null }>}
 */
export function resolveClients(byPort, peerMap, bytesPerSecFor) {
  /** @type {Record<number, { clients: object[], error: null }>} */
  const out = {};
  for (const [port, ipMap] of byPort) {
    const clients = [];
    for (const [ip, agg] of ipMap) {
      const peer = peerMap.get(ip);
      const loopback = ip === "127.0.0.1" || ip === "::1";
      const bytesPerSec =
        typeof bytesPerSecFor === "function"
          ? bytesPerSecFor(port, ip, agg.bytesSent || 0, agg.bytesReceived || 0)
          : 0;
      clients.push({
        ip,
        name: peer?.name ?? (loopback ? "local" : null),
        dnsName: peer?.dnsName ?? null,
        connections: agg.connections,
        online: peer?.online ?? null,
        recvQ: agg.recvQ,
        sendQ: agg.sendQ,
        lastSndMs: agg.lastSndMs,
        lastRcvMs: agg.lastRcvMs,
        bytesPerSec: Math.round(bytesPerSec),
        serving: false,
      });
    }
    clients.sort(sortClients);
    out[port] = { clients: clients.slice(0, MAX_CLIENTS), error: null };
  }
  return out;
}

function sortClients(a, b) {
  if (Boolean(b.serving) !== Boolean(a.serving)) return a.serving ? -1 : 1;
  if ((b.bytesPerSec || 0) !== (a.bytesPerSec || 0)) {
    return (b.bytesPerSec || 0) - (a.bytesPerSec || 0);
  }
  if (b.connections !== a.connections) return b.connections - a.connections;
  const an = (a.name || a.ip).toLowerCase();
  const bn = (b.name || b.ip).toLowerCase();
  return an < bn ? -1 : an > bn ? 1 : 0;
}

/**
 * Engine is generating or prefilling — tok/s on the card is from a live request.
 * @param {object} [engine]
 */
export function engineIsBusy(engine) {
  if (!engine || typeof engine !== "object") return false;
  // Gate on the numbers on the card (tok/s), not requestsRunning — a stuck
  // run=1 with 0 tok/s is not "being served at this tok/s".
  return (
    (Number(engine.generationTps) || 0) > ENGINE_TPS_BUSY ||
    (Number(engine.prefillTps) || 0) > ENGINE_TPS_BUSY
  );
}

/**
 * A peer is moving an HTTP body, not just sitting on a keep-alive.
 * @param {object} c
 */
export function socketLooksActive(c) {
  if (!c || typeof c !== "object") return false;
  // send-Q/recv-Q: streaming reply still buffered. Byte-rate is a bad
  // discriminator — sparkDash's /metrics scrape is tens of KB every poll.
  if ((c.recvQ || 0) > 0 || (c.sendQ || 0) > 0) return true;
  if (c.lastSndMs != null && c.lastSndMs < RECENT_MS) return true;
  if (c.lastRcvMs != null && c.lastRcvMs < RECENT_MS) return true;
  return false;
}

/**
 * Mark `serving` only when the engine is busy AND that IP's sockets are
 * moving. Idle keep-alives stay `serving: false`. Loopback is never the
 * live client unless nothing else qualifies.
 * @param {object[]} clients
 * @param {object} [engine]
 * @returns {object[]}
 */
export function annotateServing(clients, engine) {
  const list = Array.isArray(clients) ? clients.map((c) => ({ ...c, serving: false })) : [];
  if (!engineIsBusy(engine) || list.length === 0) return list.sort(sortClients);

  const remote = list.filter((c) => c.ip !== "127.0.0.1" && c.ip !== "::1");
  const active = list.filter((c) => socketLooksActive(c));
  const remoteActive = active.filter((c) => c.ip !== "127.0.0.1" && c.ip !== "::1");
  let winners = remoteActive.length > 0 ? remoteActive : [];
  if (winners.length === 0 && active.length > 0) winners = active;
  // ss without -i has no lastsnd: if the engine is busy and there is exactly
  // one remote IP, that is the live client. Do NOT do this when lastsnd is
  // present — a single idle keep-alive from igor would light up every poll.
  const hasTiming = list.some((c) => c.lastSndMs != null || c.lastRcvMs != null);
  if (winners.length === 0 && !hasTiming && remote.length === 1) winners = remote;
  const winSet = new Set(winners.map((c) => c.ip));
  for (const c of list) c.serving = winSet.has(c.ip);
  return list.sort(sortClients);
}

export class LlmClientsProbe {
  /**
   * @param {object} spark
   */
  constructor(spark) {
    this.spark = spark;
    /** @type {Map<string, { name: string, dnsName: string | null, online: boolean | null }>} */
    this._peerMap = new Map();
    this._peerAt = 0;
    /** @type {Map<string, { sent: number, recv: number, at: number }>} */
    this._prevBytes = new Map();
    /** Recently-seen peers, kept after their connections close.
     * @type {Map<string, { name: string | null, dnsName: string | null, online: boolean | null, lastSeenAt: number }>} */
    this._recent = new Map();
    /** Listen-port owners: "docker" when a docker-proxy holds the port.
     * @type {Map<number, { owner: string, at: number }>} */
    this._listenOwner = new Map();
    this.error = null;
  }

  /** @param {object} spark */
  setTarget(spark) {
    this.spark = spark ?? this.spark;
    this._recent.clear();
    this._listenOwner.clear();
    this.error = null;
  }

  dispose() {}

  _hasHostProc() {
    return fs.existsSync(path.join(HOST_PATHS.PROC, "1", "ns", "mnt"));
  }

  /**
   * @param {string} cmd
   * @param {number} [timeoutMs]
   * @returns {Promise<string>}
   */
  async _execLocal(cmd, timeoutMs = TAILSCALE_PROBE_TIMEOUT_MS) {
    const { execFile } = await import("child_process");
    const useHostNs = this._hasHostProc();
    const file = useHostNs ? "nsenter" : "sh";
    const args = useHostNs
      ? ["--mount=" + path.join(HOST_PATHS.PROC, "1", "ns", "mnt"), "--", "sh", "-c", cmd]
      : ["-c", cmd];
    return new Promise((resolve, reject) => {
      execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || "").trim() || err.message));
        resolve(String(stdout).trim());
      });
    });
  }

  /**
   * @param {string} cmd
   * @returns {Promise<string>}
   */
  async _run(cmd) {
    if (this.spark?.isLocal) return this._execLocal(cmd);
    return sshExec(this.spark, cmd, { timeoutMs: TAILSCALE_PROBE_TIMEOUT_MS });
  }

  /**
   * @param {number} port
   * @param {string} ip
   * @param {number} sent
   * @param {number} recv
   */
  _bytesPerSec(port, ip, sent, recv) {
    const key = `${port}|${ip}`;
    const now = Date.now();
    const prev = this._prevBytes.get(key);
    this._prevBytes.set(key, { sent, recv, at: now });
    if (!prev) return 0;
    const dt = (now - prev.at) / 1000;
    if (dt <= 0) return 0;
    const dSent = sent >= prev.sent ? sent - prev.sent : sent;
    const dRecv = recv >= prev.recv ? recv - prev.recv : recv;
    return (dSent + dRecv) / dt;
  }

  /**
   * Which process listens on these ports? "docker" = docker-proxy owns the
   * listen socket, so host-side peers are the proxy, not the real clients
   * (the engine sits in a container netns behind it). Never throws.
   * @param {number[]} ports
   * @returns {Promise<void>}
   */
  async _refreshListenOwners(ports) {
    const now = Date.now();
    const stale = ports.filter((p) => {
      const e = this._listenOwner.get(p);
      return !e || now - e.at > LISTEN_CHECK_MS;
    });
    if (stale.length === 0) return;
    let out = "";
    try {
      out = await this._run("ss -Htlnp");
    } catch {
      return; // keep previous owners; without -p we just don't look through
    }
    for (const port of stale) {
      let owner = "host";
      for (const line of String(out).split("\n")) {
        if (!line.includes(":" + port + " ")) continue;
        if (line.includes("docker-proxy")) owner = "docker";
        break;
      }
      this._listenOwner.set(port, { owner, at: now });
    }
  }

  /**
   * Read ESTAB peers from inside every container netns that could hold the
   * engine (host listener is docker-proxy). Merges per-port: container peers
   * carry the pre-NAT client IPs the host cannot see. Best effort — on any
   * failure the host-side view stands.
   * @param {number[]} ports
   * @returns {Promise<Map<number, Map<string, object>> | null>}
   */
  async _containerPeers(dockerPorts) {
    if (dockerPorts.length === 0) return null;
    let ids = "";
    try {
      ids = await this._run("docker ps -q");
    } catch {
      return null;
    }
    const cids = String(ids).split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 16);
    /** @type {Map<number, Map<string, object>>} */
    const merged = new Map();
    for (const cid of cids) {
      let text;
      try {
        // ss inside the container netns; -Hti has the same shape as the host read.
        text = await this._run(
          `CID=${cid}; PID=$(docker inspect -f '{{.State.Pid}}' "$CID" 2>/dev/null); ` +
          `[ -n "$PID" ] && [ "$PID" != "0" ] && nsenter -t "$PID" -n ss -Hti || true`
        );
      } catch {
        continue;
      }
      if (!text || !text.includes("ESTAB")) continue;
      // The container\'s engine port differs from the host port (NAT), so parse
      // without a port filter and keep only groups whose peers are not loopback
      // — the engine\'s inbound traffic, not internal IPC.
      const counts = parseSsEstablished(text, []);
      for (const [, ipMap] of counts) {
        const nonLoop = [...ipMap.entries()].filter(
          ([ip]) => ip !== "127.0.0.1" && ip !== "::1"
        );
        if (nonLoop.length === 0) continue;
        const port = dockerPorts[0];
        let dst = merged.get(port);
        if (!dst) {
          dst = new Map();
          merged.set(port, dst);
        }
        for (const [ip, agg] of nonLoop) {
          const cur = dst.get(ip);
          if (!cur) dst.set(ip, agg);
          else {
            cur.connections += agg.connections;
            cur.recvQ += agg.recvQ;
            cur.sendQ += agg.sendQ;
            cur.bytesSent += agg.bytesSent;
            cur.bytesReceived += agg.bytesReceived;
            const m = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
            cur.lastSndMs = m(cur.lastSndMs, agg.lastSndMs);
            cur.lastRcvMs = m(cur.lastRcvMs, agg.lastRcvMs);
          }
        }
      }
    }
    return merged.size > 0 ? merged : null;
  }

  /**
   * Merge closed-since-last-poll peers back onto the card with a decay
   * window, so a finished burst still shows who it was serving.
   * @param {number} port
   * @param {Map<string, object>} live  ip -> agg for currently-ESTAB peers
   * @param {Map<string, { name: string, dnsName: string | null, online: boolean | null }>} peerMap
   */
  _rememberRecent(port, live, peerMap) {
    const now = Date.now();
    for (const [ip, agg] of live) {
      const peer = peerMap.get(ip);
      this._recent.set(`${port}|${ip}`, {
        name: peer?.name ?? (ip === "127.0.0.1" || ip === "::1" ? "local" : null),
        dnsName: peer?.dnsName ?? null,
        online: peer?.online ?? null,
        lastSeenAt: now,
      });
    }
    for (const [key, e] of this._recent) {
      if (!key.startsWith(port + "|")) continue;
      if (now - e.lastSeenAt > RECENT_DECAY_MS) this._recent.delete(key);
      else if (!live.has(key.slice(key.indexOf("|") + 1))) {
        // keep: still within decay window, connection gone
      }
    }
  }

  /**
   * Never throws.
   * @param {number[]} listenPorts
   * @returns {Promise<{ byPort: Record<number, { clients: object[], error: string | null }>, error: string | null }>}
   */
  async probe(listenPorts) {
    const ports = (Array.isArray(listenPorts) ? listenPorts : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
    if (ports.length === 0) {
      this.error = null;
      return { byPort: {}, error: null };
    }

    const needPeers = Date.now() - this._peerAt > PEER_TTL_MS;
    // No sport= filter — iproute2 filter syntax varies; we already drop
    // non-listen-port rows in parseSsEstablished.
    const ssCmd = "ss -Hti";
    const cmd = needPeers
      ? `${ssCmd}; echo ${SPLIT_MARK}; tailscale status --json || true`
      : ssCmd;

    let out;
    try {
      out = await this._run(cmd);
    } catch (err) {
      this.error = err.message || "ss failed";
      return this._empty(ports, this.error);
    }

    let ssText = out;
    let tsText = null;
    if (needPeers) {
      const idx = out.indexOf(SPLIT_MARK);
      if (idx >= 0) {
        ssText = out.slice(0, idx).trim();
        tsText = out.slice(idx + SPLIT_MARK.length).trim();
      }
    }

    if (tsText) {
      try {
        this._peerMap = peerMapFromStatus(JSON.parse(tsText));
        this._peerAt = Date.now();
      } catch {
        /* keep previous map */
      }
    }

    let counts = parseSsEstablished(ssText, ports);

    // docker look-through: when docker-proxy owns a listen port, host-side
    // peers are the proxy's loopback relays — the real client IP only exists
    // inside the container netns. Look through only when a docker-owned
    // port's host view is all-loopback (nothing to lose, SSH cost only then).
    await this._refreshListenOwners(ports);
    const dockerPorts = ports.filter(
      (p) => this._listenOwner.get(p)?.owner === "docker" &&
        (() => {
          const host = counts.get(p);
          return Boolean(host) && [...host.keys()].every((ip) => ip === "127.0.0.1" || ip === "::1");
        })()
    );
    if (dockerPorts.length > 0) {
      const contPeers = await this._containerPeers(dockerPorts);
      if (contPeers) {
        for (const [port, ipMap] of contPeers) {
          const host = counts.get(port);
          if (!host) continue;
          // Drop the proxy's own loopback relay rows and take the container's.
          for (const ip of [...host.keys()]) host.delete(ip);
          for (const [ip, agg] of ipMap) {
            const cur = host.get(ip);
            if (!cur) host.set(ip, agg);
            else {
              cur.connections += agg.connections;
              cur.recvQ += agg.recvQ; cur.sendQ += agg.sendQ;
              cur.bytesSent += agg.bytesSent; cur.bytesReceived += agg.bytesReceived;
              const m = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
              cur.lastSndMs = m(cur.lastSndMs, agg.lastSndMs);
              cur.lastRcvMs = m(cur.lastRcvMs, agg.lastRcvMs);
            }
          }
        }
      }
    }

    const byPort = resolveClients(counts, this._peerMap, (port, ip, sent, recv) =>
      this._bytesPerSec(port, ip, sent, recv)
    );
    for (const port of ports) {
      const entry = (byPort[port] = byPort[port] || { clients: [], error: null });
      // Decay memory: peers whose connections closed this window stay listed.
      const live = new Map((counts.get(port) || new Map()).entries());
      this._rememberRecent(port, live, this._peerMap);
      const now = Date.now();
      const have = new Set(entry.clients.map((c) => c.ip));
      for (const [key, e] of this._recent) {
        if (!key.startsWith(port + "|")) continue;
        const ip = key.slice(key.indexOf("|") + 1);
        if (have.has(ip) || now - e.lastSeenAt > RECENT_DECAY_MS) continue;
        if (
          this._listenOwner.get(port)?.owner === "docker" &&
          (ip === "127.0.0.1" || ip === "::1")
        ) {
          // Proxy relay rows are replaced by look-through; don't resurrect.
          this._recent.delete(key);
          continue;
        }
        if (entry.clients.length >= MAX_CLIENTS) break;
        entry.clients.push({
          ip,
          name: e.name,
          dnsName: e.dnsName,
          connections: 0,
          online: e.online,
          recvQ: 0,
          sendQ: 0,
          lastSndMs: null,
          lastRcvMs: null,
          bytesPerSec: 0,
          serving: false,
          recent: true,
          lastSeenAt: e.lastSeenAt,
        });
      }
      entry.clients.sort(sortClients);
    }
    this.error = null;
    return { byPort, error: null };
  }

  /**
   * @param {number[]} ports
   * @param {string} error
   */
  _empty(ports, error) {
    /** @type {Record<number, { clients: object[], error: string | null }>} */
    const byPort = {};
    for (const port of ports) byPort[port] = { clients: [], error };
    return { byPort, error };
  }
}
