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
  const ports = new Set(
    (Array.isArray(listenPorts) ? listenPorts : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535)
  );
  /** @type {Map<number, Map<string, ReturnType<typeof emptyAgg>>>} */
  const byPort = new Map();
  if (typeof text !== "string" || ports.size === 0) return byPort;

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
    if (!ports.has(local.port)) continue;

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
    this.error = null;
  }

  /** @param {object} spark */
  setTarget(spark) {
    this.spark = spark ?? this.spark;
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

    const counts = parseSsEstablished(ssText, ports);
    const byPort = resolveClients(counts, this._peerMap, (port, ip, sent, recv) =>
      this._bytesPerSec(port, ip, sent, recv)
    );
    for (const port of ports) {
      if (!byPort[port]) byPort[port] = { clients: [], error: null };
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
