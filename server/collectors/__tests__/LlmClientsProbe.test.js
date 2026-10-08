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
