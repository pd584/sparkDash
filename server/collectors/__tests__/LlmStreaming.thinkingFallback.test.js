/**
 * A server that validates template options (Flare on a DeepSeek package) refuses
 * `thinking` and `thinking_mode: "disabled"`; thinking-off must still get through.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import http from "node:http";
import { applyThinkingFlags, runStreamingRequest } from "../LlmStreaming.js";

function strictServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const ctk = JSON.parse(raw).chat_template_kwargs ?? {};
      seen.push(Object.keys(ctk).sort().join(","));
      if (Object.keys(ctk).some((k) => k !== "enable_thinking")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":{"message":"unsupported DeepSeek prompt option"}}');
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen })));
}

test("thinking off: falls back to enable_thinking only after two 400s", async () => {
  const { server, seen } = await strictServer();
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
    const body = applyThinkingFlags(
      { messages: [{ role: "user", content: "hi" }], max_tokens: 8, stream: true },
      "m",
      false
    );
    const result = await runStreamingRequest(url, body, AbortSignal.timeout(10_000), {
      retryOnThinking400: true,
      thinking: false,
    });
    assert.equal(result.error ?? null, null);
    assert.equal(seen.at(-1), "enable_thinking");
    assert.equal(seen.length, 3);
  } finally {
    server.close();
  }
});
