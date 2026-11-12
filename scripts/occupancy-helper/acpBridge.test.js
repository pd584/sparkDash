import test from "node:test";
import assert from "node:assert/strict";
import { argvFromEnv, createAcpBridge } from "./acpBridge.js";

function scriptedProcess(onMessage) {
  const dataHandlers = [];
  const proc = {
    emitStdout(chunk) { for (const fn of dataHandlers) fn(Buffer.from(chunk)); },
    killed: false,
    signal: null,
    written: [],
    stdout: {
      on(event, fn) {
        if (event === "data") dataHandlers.push(fn);
      },
    },
    stderr: { on() {} },
    stdin: {
      write(chunk) {
        const text = String(chunk);
        proc.written.push(text);
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          onMessage(msg, (reply) => {
            const raw = typeof reply === "string" ? reply : JSON.stringify(reply);
            for (const fn of dataHandlers) fn(Buffer.from(`${raw}\n`));
          });
        }
        return true;
      },
    },
    once() {},
    kill(signal) {
      proc.killed = true;
      proc.signal = signal;
    },
  };
  return proc;
}

function initResult(list = {}) {
  return { agentCapabilities: { sessionCapabilities: { list } } };
}

test("argv is split without a shell", () => {
  assert.deepEqual(argvFromEnv("opencode acp"), ["opencode", "acp"]);
  assert.deepEqual(argvFromEnv('["omp","acp"]'), ["omp", "acp"]);
  assert.throws(() => argvFromEnv("openclaw\nacp"), /invalid/);
});

test("an empty page, a paged list, and a terminal empty page stay inside session/list", async () => {
  let lists = 0;
  let spawns = 0;
  const bridge = createAcpBridge({
    harness: "opencode",
    argv: ["opencode", "acp"],
    openProcess: () => {
      spawns += 1;
      return scriptedProcess((msg, reply) => {
        if (msg.method === "initialize") reply({ jsonrpc: "2.0", id: msg.id, result: initResult() });
        if (msg.method === "session/list") {
          lists += 1;
          if (lists === 1) reply({ jsonrpc: "2.0", id: msg.id, result: { sessions: [] } });
          else if (lists === 2) {
            reply({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessions: [{ sessionId: "a", title: "A" }, { sessionId: "b", title: "B" }], nextCursor: "p2" },
            });
          } else if (lists === 3) {
            reply({ jsonrpc: "2.0", id: msg.id, result: { sessions: [{ sessionId: "c", title: "C" }] } });
          } else if (lists === 4) {
            reply({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessions: [{ sessionId: "d", title: "D" }], nextCursor: "more" },
            });
          } else {
            reply({ jsonrpc: "2.0", id: msg.id, result: { sessions: [], nextCursor: "more" } });
          }
        }
        if (msg.method === "session/prompt" || msg.method === "session/new") {
          throw new Error(`sent ${msg.method}`);
        }
      });
    },
  });

  await bridge.refresh();
  assert.equal(bridge.current().rows.length, 0);
  assert.equal(bridge.current().coverage, "supported");

  await bridge.refresh();
  assert.deepEqual(bridge.current().rows.map((row) => row.sessionId), ["a", "b", "c"]);
  assert.equal(bridge.current().rows[0].activity, "unknown");

  await bridge.refresh();
  assert.deepEqual(bridge.current().rows.map((row) => row.sessionId), ["d"]);
  assert.equal(bridge.current().stale, false);
  assert.deepEqual([...new Set(bridge.sent())], ["initialize", "session/list"]);
  assert.equal(spawns, 1);
});

test("a repeated cursor keeps the last good rows", async () => {
  let lists = 0;
  const bridge = createAcpBridge({
    harness: "omp",
    argv: ["omp", "acp"],
    openProcess: () => scriptedProcess((msg, reply) => {
      if (msg.method === "initialize") reply({ jsonrpc: "2.0", id: msg.id, result: initResult() });
      if (msg.method === "session/list") {
        lists += 1;
        if (lists === 1) {
          reply({ jsonrpc: "2.0", id: msg.id, result: { sessions: [{ sessionId: "kept", title: "Kept" }] } });
        } else {
          reply({ jsonrpc: "2.0", id: msg.id, result: { sessions: [{ sessionId: "x" }], nextCursor: "loop" } });
        }
      }
    }),
  });
  await bridge.refresh();
  await bridge.refresh();
  const current = bridge.current();
  assert.deepEqual(current.rows.map((row) => row.sessionId), ["kept"]);
  assert.equal(current.stale, true);
  assert.equal(current.coverage, "partial");
  assert.match(current.error, /repeated cursor/);
});

test("a harness without session/list is not polled again until stop", async () => {
  let spawns = 0;
  const bridge = createAcpBridge({
    harness: "openclaw",
    argv: ["openclaw", "acp"],
    openProcess: () => {
      spawns += 1;
      return scriptedProcess((msg, reply) => {
        if (msg.method === "initialize") {
          reply({ jsonrpc: "2.0", id: msg.id, result: { agentCapabilities: { sessionCapabilities: {} } } });
        }
      });
    },
  });
  await bridge.refresh();
  assert.equal(bridge.current().coverage, "unsupported");
  assert.equal(bridge.current().rows.length, 0);
  await bridge.refresh();
  assert.equal(spawns, 1);
  bridge.stop();
  await bridge.refresh();
  assert.equal(spawns, 2);
});

test("one refresh is shared and a client RPC is refused", async () => {
  let spawns = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let proc;
  const bridge = createAcpBridge({
    harness: "opencode",
    argv: ["opencode", "acp"],
    openProcess: () => {
      spawns += 1;
      proc = scriptedProcess((msg, reply) => {
        if (msg.method === "initialize") {
          gate.then(() => reply({ jsonrpc: "2.0", id: msg.id, result: initResult() }));
        }
        if (msg.method === "session/list") {
          reply({ jsonrpc: "2.0", id: msg.id, result: { sessions: [] } });
          reply({ jsonrpc: "2.0", id: 99, method: "session/prompt", params: {} });
        }
      });
      return proc;
    },
  });
  const first = bridge.refresh();
  const second = bridge.refresh();
  await Promise.resolve();
  assert.equal(spawns, 1);
  release();
  await first;
  await second;
  assert.equal(spawns, 1);
  assert.match(proc.written.join(""), /-32601/);
  assert.equal(bridge.sent().includes("session/prompt"), false);
});

test("stop drops a late RPC", async () => {
  let replyInit;
  const bridge = createAcpBridge({
    harness: "omp",
    argv: ["omp", "acp"],
    openProcess: () => scriptedProcess((msg, reply) => {
      if (msg.method === "initialize") replyInit = () => reply({ jsonrpc: "2.0", id: msg.id, result: initResult() });
    }),
  });
  const pending = bridge.refresh();
  await Promise.resolve();
  bridge.stop();
  replyInit();
  await pending;
  assert.equal(bridge.current().rows.length, 0);
  assert.equal(bridge.current().coverage, "unavailable");
  assert.equal(bridge.current().observedAt, null);
});

test("a missing adapter binary reports unavailable without crashing the helper", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const moduleUrl = new URL("./acpBridge.js", import.meta.url).href;
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `
    import { createAcpBridge } from ${JSON.stringify(moduleUrl)};
    const bridge = createAcpBridge({ harness: 'omp', argv: ['/nonexistent/sparkdash-fixture-adapter'] });
    try {
      const result = await bridge.refresh();
      console.log(result.coverage);
    } finally { bridge.stop(); }
  `], { timeout: 3000 });
  assert.equal(stdout.trim(), "unavailable");
});

test("adapter children cannot read the helper bearer but keep legitimate configuration", async () => {
  const { defaultOpenProcess } = await import("./acpBridge.js");
  const { once } = await import("node:events");
  const savedToken = process.env.OCCUPANCY_TOKEN;
  const savedConfig = process.env.OMP_ACP_COMMAND;
  process.env.OCCUPANCY_TOKEN = "disposable-fixture-only";
  process.env.OMP_ACP_COMMAND = "fixture-command";
  let proc;
  try {
    proc = defaultOpenProcess([process.execPath, "-e", `console.log(JSON.stringify({
      tokenAbsent: !Object.hasOwn(process.env, 'OCCUPANCY_TOKEN'),
      configKept: process.env.OMP_ACP_COMMAND === 'fixture-command',
      pathKept: Boolean(process.env.PATH),
      homeKept: Boolean(process.env.HOME)
    }))`]);
    let output = "";
    proc.stdout.on("data", (chunk) => { output += chunk; });
    const [code] = await once(proc, "close");
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(output), { tokenAbsent: true, configKept: true, pathKept: true, homeKept: true });
  } finally {
    if (savedToken === undefined) delete process.env.OCCUPANCY_TOKEN;
    else process.env.OCCUPANCY_TOKEN = savedToken;
    if (savedConfig === undefined) delete process.env.OMP_ACP_COMMAND;
    else process.env.OMP_ACP_COMMAND = savedConfig;
    if (proc && proc.exitCode === null) proc.kill();
  }
});

for (const suffix of ["", "\n"]) {
  test(`oversized ACP ${suffix ? "line" : "unterminated output"} fails and closes only its child`, async () => {
    let proc;
    let lists = 0;
    const bridge = createAcpBridge({
      harness: "omp", argv: ["fixture"], stdoutCap: 1024,
      openProcess: () => {
        proc = scriptedProcess((msg, reply) => {
          if (msg.method === "initialize") reply({ id: msg.id, result: initResult() });
          if (msg.method === "session/list") {
            if (++lists === 1) reply({ id: msg.id, result: { sessions: [{ sessionId: "kept" }] } });
            else queueMicrotask(() => {
              proc.emitStdout("x".repeat(1025) + suffix);
              // Bound the reproduction on the old code, which otherwise waits for its RPC timeout.
              setImmediate(() => reply({ id: msg.id, result: { sessions: [] } }));
            });
          }
        });
        return proc;
      },
    });
    try {
      await bridge.refresh();
      const result = await bridge.refresh();
      assert.equal(result.stale, true);
      assert.match(result.error, /stdout.*cap/);
      assert.deepEqual(result.rows.map((row) => row.sessionId), ["kept"]);
      assert.equal(proc.killed, true);
    } finally { bridge.stop(); }
  });
}

test("persistent allowed traffic has bounded RPC history and bounded stored row fields", async () => {
  const bridge = createAcpBridge({
    harness: "omp", argv: ["fixture"],
    openProcess: () => scriptedProcess((msg, reply) => reply({
      id: msg.id,
      result: msg.method === "initialize" ? initResult() : { sessions: [
        { sessionId: "ok", title: "t".repeat(1000), cwd: "c".repeat(1000), updatedAt: "u".repeat(1000) },
        { sessionId: "s".repeat(1000) },
      ] },
    })),
  });
  try {
    for (let i = 0; i < 200; i++) await bridge.refresh();
    assert.ok(bridge.sent().length <= 64, "diagnostic history must stay bounded");
    assert.equal(bridge.current().coverage, "supported");
    const [row] = bridge.current().rows;
    assert.equal(bridge.current().rows.length, 1);
    assert.equal(row.title.length, 200);
    assert.equal(row.cwd.length, 500);
    assert.ok(row.updatedAt.length <= 64);
  } finally { bridge.stop(); }
});

test("allowed frames can share a chunk and split UTF-8 without exceeding the per-frame cap", async () => {
  let proc;
  const bridge = createAcpBridge({
    harness: "omp", argv: ["fixture"], stdoutCap: 256,
    openProcess: () => {
      proc = scriptedProcess((msg, reply) => {
        if (msg.method === "initialize") reply({ id: msg.id, result: initResult() });
        else {
          const noise = '{"jsonrpc":"2.0","method":"notice"}\n'.repeat(100);
          const frame = Buffer.from(JSON.stringify({ id: msg.id, result: { sessions: [{ sessionId: "ok", title: "é" }] } }) + "\n");
          const split = frame.indexOf(Buffer.from("é")) + 1;
          proc.emitStdout(Buffer.concat([Buffer.from(noise), frame.subarray(0, split)]));
          proc.emitStdout(frame.subarray(split));
        }
      });
      return proc;
    },
  });
  try {
    const result = await bridge.refresh();
    assert.equal(result.coverage, "supported");
    assert.equal(result.rows[0].title, "é");
  } finally { bridge.stop(); }
});

test("oversized stdout terminates the owned real child and permits a fresh child", { timeout: 3000 }, async () => {
  const { defaultOpenProcess } = await import("./acpBridge.js");
  const { once } = await import("node:events");
  let proc;
  let closed;
  let starts = 0;
  const script = `
    process.on("SIGTERM", () => {});
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.on('line', line => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') console.log(JSON.stringify({ id: msg.id, result: { agentCapabilities: { sessionCapabilities: { list: {} } } } }));
      else if (process.argv[1] === 'flood') process.stdout.write('x'.repeat(2048));
      else console.log(JSON.stringify({ id: msg.id, result: { sessions: [] } }));
    });
  `;
  const bridge = createAcpBridge({
    harness: "omp", argv: ["fixture"], stdoutCap: 1024,
    openProcess: () => {
      proc = defaultOpenProcess([process.execPath, "-e", script, starts++ === 0 ? "flood" : "good"]);
      closed = once(proc, "close");
      return proc;
    },
  });
  try {
    const failed = await bridge.refresh();
    assert.equal(failed.coverage, "unavailable");
    assert.match(failed.error, /stdout.*cap/);
    await closed;
    assert.throws(() => process.kill(proc.pid, 0), { code: "ESRCH" });
    assert.equal((await bridge.refresh()).coverage, "supported");
    bridge.stop();
    await closed;
    assert.throws(() => process.kill(proc.pid, 0), { code: "ESRCH" });
  } finally { bridge.stop(); }
});
