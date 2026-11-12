import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadHermes, mapHermesSession } from "./hermesAdapter.js";

test("missing Hermes state is unavailable, not an empty success", async () => {
  assert.equal((await loadHermes({})).coverage, "unavailable");
  assert.equal((await loadHermes({ stateDir: path.join(os.tmpdir(), "sparkdash-hermes-missing") })).coverage, "unavailable");
});

test("a corrupt sessions file is unavailable and a real empty file is supported", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-hermes-"));
  fs.writeFileSync(path.join(dir, "sessions.json"), "{");
  const corrupt = await loadHermes({ stateDir: dir });
  assert.equal(corrupt.coverage, "unavailable");
  assert.match(corrupt.error, /corrupt/);
  assert.equal(corrupt.rows.length, 0);

  fs.writeFileSync(path.join(dir, "sessions.json"), "[]");
  const empty = await loadHermes({ stateDir: dir });
  assert.equal(empty.coverage, "supported");
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.error, null);
});

test("generating comes from running state, not from how old the timestamp is", () => {
  const idle = mapHermesSession({
    id: "old",
    title: "Old",
    status: "idle",
    updated_at: "2020-01-01T00:00:00Z",
  });
  assert.equal(idle.activity, "unknown");
  assert.equal(idle.activityProvenance, "none");

  const live = mapHermesSession(
    { id: "live", title: "Live", running: true, updated_at: "2020-01-01T00:00:00Z", billing_base_url: "http://10.0.0.8:8000/v1" },
    {}
  );
  assert.equal(live.activity, "generating");
  assert.equal(live.activityProvenance, "native");
  assert.deepEqual(live.origin, { host: "10.0.0.8", port: 8000 });
});

test("a state.db read failure is partial and does not pretend the list is empty-healthy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-hermes-db-"));
  fs.writeFileSync(path.join(dir, "state.db"), "");
  const failed = await loadHermes({ stateDir: dir, readDb: async () => { throw new Error("locked"); } });
  assert.equal(failed.coverage, "partial");
  assert.match(failed.error, /locked/);
  const none = await loadHermes({ stateDir: dir, readDb: () => null });
  assert.equal(none.coverage, "partial");
  assert.match(none.error, /no readable sessions/);
});

test("the private database subprocess also excludes the helper bearer", async (t) => {
  const { readHermesDb } = await import("./hermesAdapter.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-hermes-env-"));
  const savedPath = process.env.PATH;
  const savedToken = process.env.OCCUPANCY_TOKEN;
  t.after(() => {
    process.env.PATH = savedPath;
    if (savedToken === undefined) delete process.env.OCCUPANCY_TOKEN;
    else process.env.OCCUPANCY_TOKEN = savedToken;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, "python3"), `#!${process.execPath}\nconsole.log(JSON.stringify({ rows: [{
    id: 'fixture', title: !Object.hasOwn(process.env, 'OCCUPANCY_TOKEN') && Boolean(process.env.HOME) ? 'isolated' : 'exposed'
  }] }));\n`, { mode: 0o700 });
  process.env.PATH = dir;
  process.env.OCCUPANCY_TOKEN = "disposable-fixture-only";
  assert.equal((await readHermesDb(path.join(dir, "unused.db")))[0].title, "isolated");
});

test("an existing empty Hermes directory is unavailable", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-hermes-empty-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal((await loadHermes({ stateDir: dir })).coverage, "unavailable");
});

test("a pending Hermes database read yields the event loop", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-hermes-async-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "state.db"), "");
  let finish;
  const pending = loadHermes({ stateDir: dir, readDb: () => new Promise(resolve => { finish = resolve; }) });
  await new Promise(resolve => setImmediate(resolve));
  finish([]);
  assert.equal((await pending).coverage, "supported");
});

test("a real Hermes database child yields to timers and is killed on cancellation", { timeout: 3000 }, async (t) => {
  const { readHermesDb } = await import('./hermesAdapter.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-hermes-cancel-'));
  const savedPath = process.env.PATH;
  const pidFile = path.join(dir, 'child.pid');
  let pid;
  t.after(() => {
    process.env.PATH = savedPath;
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, 'python3'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`, { mode: 0o700 });
  process.env.PATH = dir;
  const controller = new AbortController();
  const pending = readHermesDb(path.join(dir, 'fixture.db'), { signal: controller.signal });
  const rejected = assert.rejects(pending, /could not be read/);
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(pidFile), true, 'event loop must run while database child is alive');
  pid = Number(fs.readFileSync(pidFile, 'utf8'));
  process.kill(pid, 0);
  controller.abort();
  await rejected;
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); pid = null; break; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(pid, null, 'owned database child must exit after cancellation');
});
