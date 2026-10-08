import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeIp,
  parseSsAddr,
  parseSsEstablished,
  peerMapFromStatus,
  resolveClients,
  annotateServing,
  engineIsBusy,
  socketLooksActive,
  LlmClientsProbe,
} from "../LlmClientsProbe.js";

const SS = `
LISTEN 0 4096 0.0.0.0:8888 0.0.0.0:*
ESTAB 0 0 100.67.27.48:8888 100.68.163.3:41234
	 cubic wscale:7,7 rto:204 rtt:0.2/0.05 ato:40 mss:1448 lastsnd:18000 lastrcv:18000 bytes_sent:240 bytes_received:180 segs_out:4 segs_in:3
ESTAB 12 4096 100.67.27.48:8888 100.68.163.3:41235
	 cubic wscale:7,7 rto:204 rtt:0.2/0.05 ato:40 mss:1448 lastsnd:80 lastrcv:40 bytes_sent:480000 bytes_received:12000 segs_out:400 segs_in:20
ESTAB 0 0 100.67.27.48:8888 100.102.211.85:50001
	 cubic lastsnd:90000 lastrcv:90000 bytes_sent:80 bytes_received:80
TIME-WAIT 0 0 100.67.27.48:8888 10.0.10.1:9
ESTAB 0 0 127.0.0.1:8888 127.0.0.1:33333
	 cubic lastsnd:2000 lastrcv:2000 bytes_sent:400 bytes_received:400
ESTAB 0 0 10.0.10.108:11434 10.0.10.105:44321
ESTAB 0 0 [::ffff:100.67.27.48]:8888 [::ffff:100.84.1.2]:9999
ESTAB 0 0 [fd7a:115c:a1e0::1]:8888 [fd7a:115c:a1e0::2]:1234
ESTAB 0 0 192.168.1.10:22 1.2.3.4:5555
`.trim();

const STATUS = {
  Self: {
    HostName: "ltd-5",
    DNSName: "ltd-5.tail736217.ts.net.",
    Online: true,
    TailscaleIPs: ["100.67.27.48", "fd7a:115c:a1e0::1"],
  },
  Peer: {
    a: {
      HostName: "igor",
      DNSName: "igor.tail736217.ts.net.",
      Online: true,
      TailscaleIPs: ["100.68.163.3"],
      Addrs: ["10.0.10.105:41641"],
    },
    b: {
      HostName: "ltd-1",
      DNSName: "ltd-1.tail736217.ts.net.",
      Online: false,
      TailscaleIPs: ["100.102.211.85"],
    },
    c: {
      HostName: "phone",
      DNSName: "phone.tail736217.ts.net.",
      Online: true,
      TailscaleIPs: ["fd7a:115c:a1e0::2"],
    },
  },
};

test("canonicalizeIp strips mapped IPv6 and brackets", () => {
  assert.equal(canonicalizeIp("::ffff:100.68.163.3"), "100.68.163.3");
  assert.equal(canonicalizeIp("[100.68.163.3]"), "100.68.163.3");
  assert.equal(canonicalizeIp("::1"), "127.0.0.1");
  assert.equal(canonicalizeIp(""), null);
});

test("parseSsAddr handles ipv4 and bracketed ipv6", () => {
  assert.deepEqual(parseSsAddr("100.68.163.3:41234"), { ip: "100.68.163.3", port: 41234 });
  assert.deepEqual(parseSsAddr("[fd7a:115c:a1e0::2]:1234"), {
    ip: "fd7a:115c:a1e0::2",
    port: 1234,
  });
  assert.deepEqual(parseSsAddr("[::ffff:10.0.10.105]:9"), { ip: "10.0.10.105", port: 9 });
  assert.equal(parseSsAddr("garbage"), null);
});

test("parseSsEstablished keeps ESTAB on listen ports and aggregates queues", () => {
  const byPort = parseSsEstablished(SS, [8888, 11434]);
  const p8888 = byPort.get(8888);
  const igor = p8888.get("100.68.163.3");
  assert.equal(igor.connections, 2);
  assert.equal(igor.sendQ, 4096);
  assert.equal(igor.lastSndMs, 80);
  assert.equal(igor.bytesSent, 480240);
  assert.equal(p8888.get("100.102.211.85").connections, 1);
  assert.equal(p8888.get("127.0.0.1").connections, 1);
  assert.equal(p8888.get("100.84.1.2").connections, 1);
  assert.equal(p8888.get("fd7a:115c:a1e0::2").connections, 1);
  assert.equal(p8888.has("10.0.10.1"), false);
  assert.equal(p8888.has("1.2.3.4"), false);
  assert.equal(byPort.get(11434).get("10.0.10.105").connections, 1);
});

test("peerMapFromStatus indexes Self and Peer by every Tailscale IP", () => {
  const map = peerMapFromStatus(STATUS);
  assert.equal(map.get("100.68.163.3").name, "igor");
  assert.equal(map.get("100.102.211.85").name, "ltd-1");
  assert.equal(map.get("100.102.211.85").online, false);
  assert.equal(map.get("100.67.27.48").name, "ltd-5");
  assert.equal(map.get("fd7a:115c:a1e0::2").name, "phone");
  assert.equal(map.get("fd7a:115c:a1e0::1").dnsName, "ltd-5.tail736217.ts.net");
  assert.equal(map.get("10.0.10.105").name, "igor");
});

test("resolveClients names known IPs and sorts by connection count", () => {
  const counts = parseSsEstablished(SS, [8888]);
  const clients = resolveClients(counts, peerMapFromStatus(STATUS))[8888].clients;
  assert.equal(clients[0].name, "igor");
  assert.equal(clients[0].connections, 2);
  assert.equal(clients[0].ip, "100.68.163.3");
  const unnamed = clients.find((c) => c.ip === "100.84.1.2");
  assert.equal(unnamed.name, null);
  const loop = clients.find((c) => c.ip === "127.0.0.1");
  assert.equal(loop.name, "local");
});

test("engineIsBusy follows tok/s, not a stuck run=1", () => {
  assert.equal(engineIsBusy({ generationTps: 40 }), true);
  assert.equal(engineIsBusy({ prefillTps: 200 }), true);
  assert.equal(engineIsBusy({ requestsRunning: 1, generationTps: 0 }), false);
  assert.equal(engineIsBusy({ generationTps: 0, requestsRunning: 0 }), false);
});

test("annotateServing stays idle when tok/s is zero", () => {
  const counts = parseSsEstablished(SS, [8888]);
  const clients = resolveClients(counts, peerMapFromStatus(STATUS))[8888].clients;
  const out = annotateServing(clients, { generationTps: 0, requestsRunning: 0 });
  assert.equal(out.every((c) => c.serving === false), true);
});

test("annotateServing does not light the only remote keep-alive when lastsnd is stale", () => {
  const clients = [
    {
      ip: "100.68.163.3",
      name: "igor",
      connections: 2,
      lastSndMs: 1163,
      lastRcvMs: 1163,
      sendQ: 0,
      recvQ: 0,
    },
  ];
  const out = annotateServing(clients, { generationTps: 0, requestsRunning: 1 });
  assert.equal(out[0].serving, false);
});

test("annotateServing marks the streaming remote IP, not keep-alives or local", () => {
  const counts = parseSsEstablished(SS, [8888]);
  const clients = resolveClients(counts, peerMapFromStatus(STATUS))[8888].clients;
  const igor = clients.find((c) => c.ip === "100.68.163.3");
  assert.equal(socketLooksActive(igor), true); // send-Q 4096 + lastsnd 80
  const idlePeer = clients.find((c) => c.ip === "100.102.211.85");
  assert.equal(socketLooksActive(idlePeer), false); // lastsnd 90s, empty queues
  const scrape = { ip: "100.68.163.3", lastSndMs: 1900, sendQ: 0, recvQ: 0, connections: 2 };
  assert.equal(socketLooksActive(scrape), false); // previous poll's /metrics GET
  const out = annotateServing(clients, { generationTps: 42, requestsRunning: 1 });
  const live = out.filter((c) => c.serving);
  assert.equal(live.length, 1);
  assert.equal(live[0].name, "igor");
  assert.equal(out[0].serving, true);
});

test("LlmClientsProbe returns empty shape when ss fails", async () => {
  const probe = new LlmClientsProbe({ isLocal: true });
  probe._run = async () => {
    throw new Error("ss: command not found");
  };
  const snap = await probe.probe([8888]);
  assert.equal(snap.error, "ss: command not found");
  assert.deepEqual(snap.byPort[8888].clients, []);
  probe.dispose();
});

test("LlmClientsProbe parses a combined ss + tailscale dump", async () => {
  const probe = new LlmClientsProbe({ isLocal: true });
  probe._run = async () => `${SS}\n__SPARKDASH_TS__\n${JSON.stringify(STATUS)}`;
  const snap = await probe.probe([8888]);
  assert.equal(snap.error, null);
  const igor = snap.byPort[8888].clients.find((c) => c.name === "igor");
  assert.equal(igor.connections, 2);
  probe.dispose();
});

test("decay memory keeps a closed peer listed as recent for the window", async () => {
  const probe = new LlmClientsProbe({ id: "x", isLocal: true, lanIp: "10.0.0.5", llmPorts: [8888] });
  const ss1 = "ESTAB 0 0  0.0.0.0:8888 10.0.0.105:40001\n\t lastsnd:12 lastrcv:20 bytes_sent:100 bytes_received:5000";
  probe._run = async () => ss1;
  probe._refreshListenOwners = async () => {};
  probe._containerPeers = async () => null;
  const snap1 = await probe.probe([8888]);
  assert.ok(snap1.byPort[8888].clients.some((c) => c.ip === "10.0.0.105"));
  // Connection closed on the next poll: decay memory keeps it, as recent.
  probe._run = async () => "ESTAB 0 0  0.0.0.0:8888 10.0.0.9:40100\n\t lastsnd:3000 lastrcv:3000 bytes_sent:50 bytes_received:60";
  const snap2 = await probe.probe([8888]);
  const recent = snap2.byPort[8888].clients.find((c) => c.ip === "10.0.0.105");
  assert.ok(recent, "closed peer still listed");
  assert.equal(recent.recent, true);
  assert.equal(recent.connections, 0);
  assert.equal(recent.serving, false);
  const marked = annotateServing(snap2.byPort[8888].clients, { generationTps: 90 });
  assert.equal(marked.find((c) => c.ip === "10.0.0.105").serving, false);
});

test("decay memory prunes entries older than the window", async () => {
  const probe = new LlmClientsProbe({ id: "x", isLocal: true, lanIp: "10.0.0.5", llmPorts: [8888] });
  probe._run = async () => "ESTAB 0 0  0.0.0.0:8888 10.0.0.7:41000\n\t lastsnd:5 lastrcv:5 bytes_sent:1 bytes_received:1";
  probe._refreshListenOwners = async () => {};
  probe._containerPeers = async () => null;
  await probe.probe([8888]);
  const key = [...probe._recent.keys()][0];
  const e = probe._recent.get(key);
  probe._recent.set(key, { ...e, lastSeenAt: Date.now() - (10 * 60_000 + 1000) });
  const snap = await probe.probe([8888]);
  assert.ok(!snap.byPort[8888].clients.some((c) => c.ip === "10.0.0.7" && c.recent));
});

test("docker look-through swaps proxy loopback rows for container peer IPs", async () => {
  const probe = new LlmClientsProbe({ id: "bert", isLocal: false, lanIp: "10.0.10.108", ssh: { host: "10.0.10.108", user: "u", auth: "key" }, llmPorts: [11434] });
  const hostSs =
    "LISTEN 0 0 0.0.0.0:11434 0.0.0.0:* users:((\"docker-proxy\",pid=1,fd=7))\n" +
    "ESTAB 0 0  127.0.0.1:11434 127.0.0.1:59000\n\t lastsnd:20 lastrcv:25 bytes_sent:900 bytes_received:400";
  const contSs =
    "ESTAB 0 0  172.17.0.2:8001 10.0.10.105:42386\n\t lastsnd:30 lastrcv:40 bytes_sent:8000 bytes_received:90000";
  probe._run = async (cmd) => {
    const c = String(cmd);
    if (c.includes("ss -Htlnp")) return hostSs.split("\n")[0];
    if (c.includes("docker ps -q")) return "abc123";
    if (c.includes("nsenter")) return contSs;
    return hostSs;
  };
  probe._peerMap = new Map([["10.0.10.105", { name: "igor", dnsName: "igor.tail", online: true }]]);
  probe._peerAt = Date.now();
  const snap = await probe.probe([11434]);
  const ips = snap.byPort[11434].clients.map((c) => c.ip);
  assert.ok(ips.includes("10.0.10.105"), "real client IP from container netns");
  assert.ok(!ips.includes("127.0.0.1"), "proxy relay row replaced");
  const igor = snap.byPort[11434].clients.find((c) => c.ip === "10.0.10.105");
  assert.equal(igor.name, "igor");
});

test("listen-owner check escalates to sudo when ss -p shows no process info", async () => {
  const probe = new LlmClientsProbe({ id: "bert", isLocal: false, ssh: { host: "x", user: "u", auth: "key" }, llmPorts: [11434] });
  const cmds = [];
  probe._run = async (cmd) => {
    cmds.push(String(cmd));
    if (String(cmd).includes("ss -Htlnp") && !String(cmd).includes("sudo")) {
      return "LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:*"; // no users=() — non-root view
    }
    if (String(cmd).includes("sudo")) {
      return "LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:* users:((\"docker-proxy\",pid=9,fd=7))";
    }
    return "";
  };
  await probe._refreshListenOwners([11434]);
  const e = probe._listenOwner.get(11434);
  assert.equal(e.owner, "docker");
  assert.ok(cmds.some((c) => c.includes("sudo -n ss -Htlnp")));
});

test("unknown owner with all-loopback host view still attempts look-through", async () => {
  const probe = new LlmClientsProbe({ id: "b", isLocal: false, ssh: { host: "x", user: "u", auth: "key" }, llmPorts: [11434] });
  const hostSs = "ESTAB 0 0  127.0.0.1:11434 127.0.0.1:59000\n\t lastsnd:20 lastrcv:25 bytes_sent:900 bytes_received:400";
  probe._run = async (cmd) => {
    const c = String(cmd);
    if (c.includes("ss -Htlnp")) return "LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:*"; // no owner info, no sudo available
    if (c.includes("docker ps -q")) return "cid1";
    if (c.includes("nsenter")) return "ESTAB 0 0  172.17.0.2:8001 10.0.10.105:42386\n\t lastsnd:30 lastrcv:40 bytes_sent:8000 bytes_received:90000";
    return hostSs;
  };
  probe._peerMap = new Map([["10.0.10.105", { name: "igor", dnsName: null, online: true }]]);
  probe._peerAt = Date.now();
  const snap = await probe.probe([11434]);
  const ips = snap.byPort[11434].clients.map((c) => c.ip);
  assert.ok(ips.includes("10.0.10.105"), "look-through ran despite unknown owner");
});

test("sticky serving keeps a chunked streamer lit between flush gaps", async () => {
  const probe = new LlmClientsProbe({ id: "b", isLocal: false, ssh: { host: "x", user: "u", auth: "key" }, llmPorts: [8888] });
  // Poll 1: igor's socket is mid-flush (lastsnd 68ms) -> active.
  probe._run = async () => "ESTAB 0 0  0.0.0.0:8888 10.0.0.105:52000\n\t lastsnd:68 lastrcv:70 bytes_sent:1000 bytes_received:400";
  probe._refreshListenOwners = async () => {};
  probe._containerPeers = async () => null;
  const s1 = await probe.probe([8888]);
  const ages1 = s1.byPort[8888].activeAgesMs;
  let marked = annotateServing(s1.byPort[8888].clients, { generationTps: 250 }, ages1);
  assert.equal(marked.find((c) => c.ip === "10.0.0.105").serving, true);
  // Poll 2, 800ms later: igor between chunks (lastsnd 1200ms > 400 gate) but
  // the sticky window (3s) keeps it lit; a fresh idle peer stays unlit.
  probe._recent.clear();
  probe._run = async () => "ESTAB 0 0  0.0.0.0:8888 10.0.0.105:52000\n\t lastsnd:1200 lastrcv:1206 bytes_sent:1600 bytes_received:700\nESTAB 0 0  0.0.0.0:8888 10.0.0.9:53000\n\t lastsnd:4000 lastrcv:4000 bytes_sent:10 bytes_received:10";
  const s2 = await probe.probe([8888]);
  marked = annotateServing(s2.byPort[8888].clients, { generationTps: 250 }, s2.byPort[8888].activeAgesMs);
  assert.equal(marked.find((c) => c.ip === "10.0.0.105").serving, true);
  assert.equal(marked.find((c) => c.ip === "10.0.0.9").serving, false);
  // Poll 3, 4s later: sticky expired, still above gate -> unlit.
  probe._recent.clear();
  for (const [k, v] of probe._activeAt) probe._activeAt.set(k, v - 4000);
  probe._run = async () => "ESTAB 0 0  0.0.0.0:8888 10.0.0.105:52000\n\t lastsnd:1300 lastrcv:1300 bytes_sent:1700 bytes_received:750";
  const s3 = await probe.probe([8888]);
  marked = annotateServing(s3.byPort[8888].clients, { generationTps: 250 }, s3.byPort[8888].activeAgesMs);
  assert.equal(marked.find((c) => c.ip === "10.0.0.105").serving, false);
});
