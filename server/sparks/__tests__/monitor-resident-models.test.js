/**
 * Resident-model discovery is an SSH exec: it must run only on units whose LLM
 * monitoring is on (never workers), and one failed run must not wipe the list.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { SparkMonitor } from "../SparkMonitor.js";

function monitorFor(overrides, probe) {
  const monitor = new SparkMonitor({
    id: "u1",
    name: "U1",
    kind: "host",
    lanIp: "192.168.10.9",
    isLocal: false,
    platform: "linux",
    comfyMonitoring: false,
    hermesMonitoring: false,
    tailscaleMonitoring: false,
    storagePollDisabled: true,
    ...overrides,
  });
  monitor._running = true;
  monitor.online = true;
  const calls = { n: 0 };
  monitor.collector.probeResidentModels = async () => {
    calls.n += 1;
    return probe();
  };
  return { monitor, calls };
}

test("resident models: not polled for workers or units with LLM monitoring off", async () => {
  for (const overrides of [{ role: "worker" }, { workerNode: true }, { role: "standalone", llmMonitoring: false }, { isLocal: true }, { platform: "windows" }]) {
    const { monitor, calls } = monitorFor(overrides, () => []);
    await monitor._pollDomain("residentModels");
    assert.equal(calls.n, 0, JSON.stringify(overrides));
  }
});

test("resident models: polled when LLM monitoring is on", async () => {
  const found = [{ modelId: "org/m", container: "vllm-a" }];
  const { monitor, calls } = monitorFor({ role: "standalone", llmMonitoring: true }, () => found);
  await monitor._pollDomain("residentModels");
  assert.equal(calls.n, 1);
  assert.deepEqual(monitor._metrics.residentModels, found);
});

test("resident models: a failed run keeps the list during the grace period, then clears it", async () => {
  const found = [{ modelId: "org/m", container: "vllm-a" }];
  let next = found;
  const { monitor } = monitorFor({ role: "standalone", llmMonitoring: true }, () => next);
  await monitor._pollDomain("residentModels");
  next = null;
  await monitor._pollDomain("residentModels");
  assert.deepEqual(monitor._metrics.residentModels, found, "a single failure must not clear the list");
  monitor._lastSuccess.residentModels = Date.now() - 10 * 60_000;
  await monitor._pollDomain("residentModels");
  assert.deepEqual(monitor._metrics.residentModels, []);
});

test("resident models: an empty list from a successful run is shown as empty", async () => {
  let next = [{ modelId: "org/m", container: "vllm-a" }];
  const { monitor } = monitorFor({ role: "standalone", llmMonitoring: true }, () => next);
  await monitor._pollDomain("residentModels");
  next = [];
  await monitor._pollDomain("residentModels");
  assert.deepEqual(monitor._metrics.residentModels, []);
});
