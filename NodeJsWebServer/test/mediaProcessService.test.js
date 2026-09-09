const assert = require("node:assert/strict");
const test = require("node:test");
const { getMediaThreads, runMediaProcess } = require("../src/services/mediaProcessService");

test("media jobs complete successfully and bound failing encoder output", async () => {
  await runMediaProcess(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: 5000 });
  await assert.rejects(
    runMediaProcess(process.execPath, ["-e", "process.stderr.write('x'.repeat(100000) + 'FINAL_ERROR', () => process.exit(2))"], { timeoutMs: 5000 }),
    (error) => error.message.length <= 16384 && error.message.endsWith("FINAL_ERROR")
  );
});

test("a stuck media process is killed on timeout", async () => {
  await assert.rejects(
    runMediaProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 100, timeoutError: "test_encoder_timeout",
    }),
    /test_encoder_timeout/
  );
});

test("shutdown aborts media jobs and prevents an already cancelled job from spawning", async () => {
  const controller = new AbortController();
  const running = runMediaProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 5000, signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(running, /media_cancelled/);
  await assert.rejects(runMediaProcess("must-not-spawn", [], { signal: controller.signal }), /media_cancelled/);
});

test("encoder thread settings cannot select unbounded automatic parallelism", () => {
  assert.equal(getMediaThreads(undefined), 1);
  assert.equal(getMediaThreads("0"), 1);
  assert.equal(getMediaThreads("invalid"), 1);
  assert.equal(getMediaThreads("2"), 2);
  assert.equal(getMediaThreads("100"), 8);
});
