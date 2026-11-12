process.env.BENCH_HISTORY_PATH = `${process.env.TMPDIR || "/tmp"}/sparkdash-context-test-history.json`;
process.env.BENCH_ACTIVE_PATH = `${process.env.TMPDIR || "/tmp"}/sparkdash-context-test-active.json`;
import { test } from "node:test";
import { strict as assert } from "node:assert";
import http from "node:http";
const { decodeBenchManager, runConcurrencyWave } = await import("../DecodeBench.js");
const { assessContextCache, buildContextPrompt } = await import("../contextFill.js");
const { validateDecodeContextBudget } = await import("../../validate.js");

const base = { sparkId: "context-test", lanIp: "127.0.0.1", port: 1, modelId: null, concurrencies: [1] };
let seq = 0;
function startAndCancel(extra) {
  const sparkId = `${base.sparkId}-${seq++}`;
  const job = decodeBenchManager.start({ ...base, sparkId, ...extra });
  decodeBenchManager.cancel(sparkId, job.benchId);
  return job.config;
}

test("contextTokens is off by default and kept in the job config when set", () => {
  assert.equal(startAndCancel({}).contextTokens, undefined);
  assert.equal(startAndCancel({ contextTokens: 0 }).contextTokens, undefined);
  assert.equal(startAndCancel({ contextTokens: "" }).contextTokens, undefined);
  assert.equal(startAndCancel({ contextTokens: 131072 }).contextTokens, 131072);
  assert.equal(startAndCancel({ contextTokens: "65536" }).contextTokens, 65536);
});

test("an out-of-range or malformed contextTokens is refused", () => {
  for (const contextTokens of [100, 300001, "abc", -5, 1.5]) {
    assert.throws(
      () => decodeBenchManager.start({ ...base, sparkId: `context-bad-${seq++}`, contextTokens }),
      { status: 400 },
      String(contextTokens)
    );
  }
});

test("deep-context prefill budget caps total prompt tokens across levels", () => {
  assert.equal(validateDecodeContextBudget([4], 131072), 524288);
  assert.equal(validateDecodeContextBudget([1], 0), 0);
  assert.throws(() => validateDecodeContextBudget([32], 300000), { status: 429 });
});

test("context prompts are unique per salt, land near the target, and end with the task", () => {
  const a = buildContextPrompt(4096, "run-0", "TASK TEXT");
  const b = buildContextPrompt(4096, "run-1", "TASK TEXT");
  assert.notEqual(a.slice(0, 200), b.slice(0, 200));
  assert.ok(a.endsWith("TASK TEXT"));
  // The filler is one common word (about one token) per entry, as in the prefill bench.
  const words = a.split(/\s+/).length;
  assert.ok(words >= 4096 * 0.97 && words <= 4096 * 1.03, `${words} words`);
  assert.equal(buildContextPrompt(4096, "run-0", "TASK TEXT"), a); // same salt: same bytes, so it is a cache hit
});

test("assessContextCache trusts the reported cached tokens, else compares first-token latency", () => {
  assert.equal(assessContextCache({ promptTokens: 1000, cachedTokens: 990, ttftMs: 0, fillTtftMs: 0 }), "cached");
  assert.equal(assessContextCache({ promptTokens: 1000, cachedTokens: 400, ttftMs: 0, fillTtftMs: 0 }), "partial");
  assert.equal(assessContextCache({ promptTokens: 1000, cachedTokens: 0, ttftMs: 200, fillTtftMs: 9000 }), "cached");
  assert.equal(assessContextCache({ promptTokens: 1000, cachedTokens: 0, ttftMs: 8000, fillTtftMs: 9000 }), "uncached");
  assert.equal(assessContextCache({ promptTokens: 1000, cachedTokens: 0, ttftMs: 0, fillTtftMs: 0 }), "unknown");
});

/** Fake chat server: remembers prompts it has prefilled and reports a cache hit for a repeat. */
function fakeServer({ cache = true } = {}) {
  const seen = new Set();
  const log = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const prompt = body.messages[0].content;
      const hit = cache && seen.has(prompt);
      seen.add(prompt);
      log.push({ maxTokens: body.max_tokens, hit, chars: prompt.length });
      const promptTokens = Math.ceil(prompt.length / 4);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const finish = () => {
        send({
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: body.max_tokens,
            total_tokens: promptTokens + body.max_tokens,
            prompt_tokens_details: { cached_tokens: hit ? promptTokens - 1 : 0 },
          },
        });
        res.write("data: [DONE]\n\n");
        res.end();
      };
      setTimeout(() => {
        const n = Math.min(body.max_tokens, 12);
        let i = 0;
        const tick = () => {
          if (i >= n) return finish();
          send({ choices: [{ delta: { content: "x" } }] });
          i += 1;
          setTimeout(tick, 5);
        };
        tick();
      }, hit ? 5 : 60);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, log, url: `http://127.0.0.1:${server.address().port}` })
    )
  );
}

async function runWave(url, extra = {}) {
  return runConcurrencyWave({
    baseUrl: url,
    modelId: "m",
    concurrency: 2,
    maxTokens: 64,
    thinking: false,
    contextTokens: 2048,
    contextSalt: "t",
    ...extra,
  });
}

test("deep-context wave prefills each stream first, then measures decode from the cached context", async () => {
  const { server, log, url } = await fakeServer();
  try {
    const progress = [];
    const wave = await runWave(url, { onPrefill: (d, t) => progress.push([d, t]) });
    // two one-token prefill requests, then two measured requests with the same prompts
    assert.deepEqual(log.map((l) => l.maxTokens), [1, 1, 64, 64]);
    assert.deepEqual(log.map((l) => l.hit), [false, false, true, true]);
    assert.notEqual(log[0].chars, 0);
    assert.deepEqual(progress.at(-1), [2, 2]);
    assert.equal(wave.contextTokens, 2048);
    assert.ok(wave.contextPrefillMs > 0);
    assert.equal(wave.contextCache.cached, 2);
    assert.equal(wave.warning, undefined);
    assert.equal(wave.streamsOk, 2);
    assert.ok(wave.streams.every((s) => s.contextCache === "cached" && s.cachedTokens > 0));
    assert.ok(wave.streams.every((s) => s.prefillTokens > 1500));
  } finally {
    server.close();
  }
});

test("deep-context wave warns when the server did not reuse the prefilled context", async () => {
  const { server, url } = await fakeServer({ cache: false });
  try {
    const wave = await runWave(url);
    assert.equal(wave.contextCache.uncached, 2);
    assert.match(wave.warning, /prefix cache miss/);
  } finally {
    server.close();
  }
});

test("a failed context prefill fails the wave instead of measuring an uncached context", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const wave = await runWave(`http://127.0.0.1:${server.address().port}`);
    assert.equal(wave.streamsOk, 0);
    assert.match(wave.error, /Context prefill failed for stream 1 of 2/);
  } finally {
    server.close();
  }
});

test("without contextTokens the wave sends no prefill pass", async () => {
  const { server, log, url } = await fakeServer();
  try {
    const wave = await runWave(url, { contextTokens: 0 });
    assert.deepEqual(log.map((l) => l.maxTokens), [64, 64]);
    assert.equal(wave.contextTokens, undefined);
    assert.equal(wave.contextCache, undefined);
  } finally {
    server.close();
  }
});
