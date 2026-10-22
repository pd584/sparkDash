/**
 * Unit tests for NVIDIA Flare (Helios) detection and metrics.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";
import { readServerGenerationTokens } from "../LlmStreaming.js";

const CARD = {
  id: "qwen3.8-flash",
  object: "model",
  owned_by: "local",
  root: "Qwen/Qwen3.8-Flash",
  max_model_len: 262144,
  flare: { max_concurrency: 4, prefill_chunk_size: 2048 },
};

const metrics = ({ gen, pre, reused, active = 0 }) => `# TYPE flare_generated_tokens_total counter
flare_generated_tokens_total ${gen}
flare_prefill_tokens_total ${pre}
flare_cache_reused_tokens_total ${reused}
flare_active_requests ${active}
flare_free_request_slots ${4 - active}
flare_pending_requests 1
flare_preemptions_total 2
flare_total_kv_tokens 1000
flare_free_kv_tokens 250
`;

test("_modelsLookLikeFlare: needs the flare card object, not owned_by", () => {
  assert.equal(LlmProbe._modelsLookLikeFlare([CARD]), true);
  assert.equal(LlmProbe._modelsLookLikeFlare([{ id: "x", owned_by: "local" }]), false);
  assert.equal(LlmProbe._modelsLookLikeFlare(null), false);
});

test("_metricsLookLikeFlare: true for flare exposition only", () => {
  assert.equal(LlmProbe._metricsLookLikeFlare(metrics({ gen: 1, pre: 1, reused: 0 })), true);
  assert.equal(LlmProbe._metricsLookLikeFlare("vllm:generation_tokens_total 10.0\n"), false);
});

test("_detectServerType: flare card → flare", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8001);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [CARD] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "flare");
});

test("_applyFlareMetrics: counter deltas give tok/s, gauges fill slots and KV", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8001);
  probe._applyFlareMetrics(metrics({ gen: 100, pre: 1000, reused: 500 }), 2, CARD.flare);
  probe._applyFlareMetrics(metrics({ gen: 300, pre: 3000, reused: 500, active: 2 }), 2, CARD.flare);
  assert.equal(probe.generationTps, 100);
  assert.equal(probe.prefillTps, 1000);
  assert.equal(probe.totalOutputTokens, 300);
  assert.equal(probe.totalPromptTokens, 3500);
  assert.equal(probe.slotsActive, 2);
  assert.equal(probe.slotsTotal, 4);
  assert.equal(probe.requestsWaiting, 1);
  assert.equal(probe.preemptionsTotal, 2);
  assert.equal(probe.kvCacheTokens, 1000);
  assert.equal(probe.kvCacheTokensAvailable, 250);
  assert.equal(probe.kvCacheUsage, 0.75);
});

test("readServerGenerationTokens: reads flare_generated_tokens_total", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => metrics({ gen: 4242, pre: 1, reused: 0 }) });
  try {
    assert.equal(await readServerGenerationTokens("http://x"), 4242);
  } finally {
    globalThis.fetch = realFetch;
  }
});
