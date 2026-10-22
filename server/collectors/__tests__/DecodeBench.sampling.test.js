process.env.BENCH_HISTORY_PATH = `${process.env.TMPDIR || "/tmp"}/sparkdash-sampling-test-history.json`;
process.env.BENCH_ACTIVE_PATH = `${process.env.TMPDIR || "/tmp"}/sparkdash-sampling-test-active.json`;
import { test } from "node:test";
import { strict as assert } from "node:assert";
const { decodeBenchManager, DECODE_BENCH_DEFAULTS } = await import("../DecodeBench.js");

const base = { sparkId: "sampling-test", lanIp: "127.0.0.1", port: 1, modelId: null, concurrencies: [1] };

let seq = 0;
function startAndCancel(extra) {
  const sparkId = `${base.sparkId}-${seq++}`;
  const job = decodeBenchManager.start({ ...base, sparkId, ...extra });
  const config = { ...job.config };
  decodeBenchManager.cancel(sparkId, job.benchId);
  return config;
}

test("decode bench defaults to temperature 0.7, with thinking on for prose only", () => {
  assert.equal(DECODE_BENCH_DEFAULTS.defaultTemperature, 0.7);
  assert.equal(DECODE_BENCH_DEFAULTS.defaultThinking, true);
  const prose = startAndCancel({ promptType: "prose" });
  assert.equal(prose.temperature, 0.7);
  assert.equal(prose.thinking, true);
  const structured = startAndCancel({});
  assert.equal(structured.temperature, 0.7);
  assert.equal(structured.thinking, false);
});

test("temperature can be chosen per run, thinking only for prose", () => {
  const off = startAndCancel({ promptType: "prose", temperature: 0, thinking: false });
  assert.equal(off.temperature, 0);
  assert.equal(off.thinking, false);
  const on = startAndCancel({ promptType: "prose", thinking: true });
  assert.equal(on.thinking, true);
  for (const promptType of ["structured", "code", "json"]) {
    assert.equal(startAndCancel({ promptType, thinking: true }).thinking, false, promptType);
  }
});

test("an out-of-range temperature is refused", () => {
  assert.throws(() => decodeBenchManager.start({ ...base, sparkId: "sampling-bad-1", temperature: 3 }), { status: 400 });
  assert.throws(() => decodeBenchManager.start({ ...base, sparkId: "sampling-bad-2", temperature: "abc" }), { status: 400 });
});
