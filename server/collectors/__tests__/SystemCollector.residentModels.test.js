import { test } from "node:test";
import { strict as assert } from "node:assert";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { SystemCollector, RESIDENT_MODELS_CMD } from "../SystemCollector.js";

const remote = { id: "test", isLocal: false, platform: "linux" };

test("resident models preserves model/container identity from private endpoints", async () => {
  const expected = [
    { modelId: "org/first", container: "primary-vllm" },
    { modelId: "org/second", container: "private-vllm" },
  ];
  const actual = await new SystemCollector(remote).collectResidentModels(async (spark, command) => {
    assert.equal(spark.id, "test");
    assert.ok(command.includes("/v1/models"));
    assert.ok(command.includes("ProxyHandler({})"));
    return JSON.stringify([...expected, { modelId: 42, container: "invalid" }]);
  });
  assert.deepEqual(actual, expected);
});

test("resident discovery degrades safely on missing tools, malformed output or SSH failure", async () => {
  const c = new SystemCollector(remote);
  for (const result of ["[]", "not json", "{}", "null"]) {
    assert.deepEqual(await c.collectResidentModels(async () => result), []);
  }
  assert.deepEqual(await c.collectResidentModels(async () => { throw new Error("SSH unavailable"); }), []);
});

test("resident discovery does not execute Linux commands on unsupported units", async () => {
  for (const config of [{ isLocal: true }, { platform: "windows" }, { platform: "darwin" }]) {
    const c = new SystemCollector({ ...remote, ...config });
    assert.deepEqual(await c.collectResidentModels(async () => assert.fail("must not execute")), []);
  }
});

// ── Runs the real helper script against a fake `docker` and local HTTP servers ──

const hasPython = spawnSync("python3", ["--version"]).status === 0;

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const json = (body) => (req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const list = (ids) => ({ data: ids.map((id) => ({ id })) });

function container(name, cmd, image = "vllm/vllm-openai:latest") {
  return {
    Name: `/${name}`,
    Config: { Image: image, Cmd: cmd },
    NetworkSettings: { Networks: { bridge: { IPAddress: "127.0.0.1" } } },
  };
}

/** Run RESIDENT_MODELS_CMD with a fake `docker` first on PATH; resolves the collector's result. */
async function discover(containers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resident-models-"));
  try {
    fs.writeFileSync(path.join(dir, "inspect.json"), JSON.stringify(containers));
    fs.writeFileSync(
      path.join(dir, "docker"),
      `#!/bin/sh\ncase "$1" in\n  ps) echo c1; echo c2 ;;\n  inspect) cat "${dir}/inspect.json" ;;\n  *) exit 1 ;;\nesac\n`,
      { mode: 0o755 },
    );
    const execute = (_spark, cmd) =>
      new Promise((resolve, reject) => {
        execFile("sh", ["-c", cmd], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 10_000 }, (err, stdout) =>
          err ? reject(err) : resolve(String(stdout).trim()),
        );
      });
    return await new SystemCollector(remote).probeResidentModels(execute);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("helper script: --port, --port=, an unbalanced quote and a bad port in one unit", { skip: !hasPython }, async () => {
  assert.ok(RESIDENT_MODELS_CMD.startsWith("python3"));
  const a = await listen(json(list(["org/a1", "org/a2"])));
  const b = await listen(json(list(["org/b"])));
  const c = await listen(json(list(["org/c"])));
  try {
    const models = await discover([
      container("alpha", ["--model", "org/a", "--port", String(a.port)]),
      container("odd-quote", ["--served-model-name", '"unbalanced', "--port", String(c.port)]),
      container("bad-port", ["--port", "not-a-number"]),
      container("beta", [`--port=${b.port}`]),
      container("postgres", ["--port", String(a.port)], "postgres:16"),
    ]);
    assert.deepEqual(
      models.map((m) => `${m.container}:${m.modelId}`).sort(),
      ["alpha:org/a1", "alpha:org/a2", "beta:org/b", "odd-quote:org/c"],
    );
  } finally {
    for (const s of [a, b, c]) s.server.close();
  }
});

test("helper script: caps models at 50 and ids at 200 chars", { skip: !hasPython }, async () => {
  const many = await listen(json(list(Array.from({ length: 300 }, (_, i) => `model-${i}`))));
  const long = await listen(json(list(["x".repeat(1000)])));
  try {
    const capped = await discover([container("many", ["--port", String(many.port)])]);
    assert.equal(capped.length, 50);
    const trimmed = await discover([container("long", ["--port", String(long.port)])]);
    assert.equal(trimmed.length, 1);
    assert.equal(trimmed[0].modelId.length, 200);
  } finally {
    for (const s of [many, long]) s.server.close();
  }
});

test("helper script: an oversized /v1/models body is dropped without hanging", { skip: !hasPython }, async () => {
  const huge = await listen(json(JSON.stringify(list(Array.from({ length: 4000 }, (_, i) => `m-${i}-${"y".repeat(60)}`)))));
  try {
    const started = Date.now();
    assert.deepEqual(await discover([container("huge", ["--port", String(huge.port)])]), []);
    assert.ok(Date.now() - started < 8000);
  } finally {
    huge.server.close();
  }
});

test("helper script: docker failure is reported as unknown, not as no models", { skip: !hasPython }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resident-models-"));
  try {
    fs.writeFileSync(path.join(dir, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const execute = (_s, cmd) =>
      new Promise((resolve, reject) =>
        execFile("sh", ["-c", cmd], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }, (err, out) => (err ? reject(err) : resolve(String(out)))),
      );
    assert.equal(await new SystemCollector(remote).probeResidentModels(execute), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collector caps and trims whatever the helper prints", async () => {
  const flood = Array.from({ length: 80 }, (_, i) => ({ modelId: `m${i}`, container: "c".repeat(500) }));
  const out = await new SystemCollector(remote).probeResidentModels(async () => JSON.stringify(flood));
  assert.equal(out.length, 50);
  assert.equal(out[0].container.length, 200);
});
