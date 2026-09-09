const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const servicePath = path.join(__dirname, "../src/services/timelapseService.js");

async function fixture(t, runMediaProcess) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timelapse-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let scans = 0;
  const nativeRequire = createRequire(servicePath);
  const module = { exports: {} };
  const source = await fs.readFile(servicePath, "utf8");
  vm.runInNewContext(source, {
    module, exports: module.exports, process, console, AbortController,
    require(id) {
      if (id === "fs/promises") return {
        ...fs,
        async readdir(...args) { scans += 1; return fs.readdir(...args); },
      };
      if (id === "./mediaProcessService" && runMediaProcess) return {
        ...nativeRequire(id), runMediaProcess,
      };
      return nativeRequire(id);
    },
  }, { filename: servicePath });
  const camera = { cameraId: "test-camera", archive: { localDir: root } };
  return { root, camera, service: module.exports, getScans: () => scans };
}

test("archive polling shares a cached scan and captures update totals without rescanning", async (t) => {
  const { service, root, camera, getScans } = await fixture(t);
  await fs.writeFile(path.join(root, "frame-first.jpg"), "first");
  const listings = await Promise.all(Array.from({ length: 5 }, () => service.listTimelapseFiles(camera, camera)));
  assert.equal(getScans(), 1);
  assert.ok(listings.every((listing) => listing === listings[0]));
  await fs.writeFile(path.join(root, "frame-next.jpg"), "next");
  await service.recordTimelapseFrame(camera, camera, "frame-next.jpg", await fs.stat(path.join(root, "frame-next.jpg")));
  const updated = await service.listTimelapseFiles(camera, camera);
  assert.equal(getScans(), 1);
  assert.equal(updated.totalBytes, 9);
  assert.equal(updated.imageFiles.length, 2);
  assert.equal(updated.latestImage.name, "frame-next.jpg");
  await service.deleteTimelapseFile(camera, camera, "frame-first.jpg");
  const afterDeletion = await service.listTimelapseFiles(camera, camera);
  assert.equal(afterDeletion.totalBytes, 4);
});

test("archive paths reject traversal, non-media files and directories", async (t) => {
  const { service, root, camera } = await fixture(t);
  await fs.writeFile(path.join(root, "frame.jpg"), "image");
  await fs.writeFile(path.join(root, "secret.txt"), "secret");
  await fs.mkdir(path.join(root, "folder.jpg"));
  for (const name of ["../outside.jpg", "..\\outside.jpg", "secret.txt", "folder.jpg", ""]) {
    await assert.rejects(service.resolveTimelapseFilePath(camera, camera, name), /invalid_timelapse_path/);
  }
  assert.equal(await service.resolveTimelapseFilePath(camera, camera, "frame.jpg"), path.join(root, "frame.jpg"));
});

test("archive paths reject symlink files", async (t) => {
  const { service, root, camera } = await fixture(t);
  await fs.writeFile(path.join(root, "secret.txt"), "secret");
  try {
    await fs.symlink(path.join(root, "secret.txt"), path.join(root, "linked.jpg"));
  } catch (error) {
    if (error.code === "EPERM") { t.skip("Symlink creation requires Windows privileges"); return; }
    throw error;
  }
  await assert.rejects(service.resolveTimelapseFilePath(camera, camera, "linked.jpg"), /invalid_timelapse_path/);
});

test("only one video build runs, deletion is blocked while encoding, and output is published atomically", async (t) => {
  let finish;
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const { service, root, camera } = await fixture(t, async (command, args) => {
    const temporaryPath = args.at(-1);
    assert.ok(temporaryPath.endsWith(".mp4.partial"));
    await fs.writeFile(temporaryPath, "encoded video");
    started();
    await new Promise((resolve) => { finish = resolve; });
  });
  await fs.writeFile(path.join(root, "frame-first.jpg"), "image");
  const building = service.buildTimelapseVideo(camera, camera);
  await didStart;
  await assert.rejects(service.buildTimelapseVideo(camera, camera), /timelapse_build_busy/);
  await assert.rejects(service.deleteTimelapseByType(camera, camera, "image"), /timelapse_build_busy/);
  const during = await service.listTimelapseFiles(camera, camera);
  assert.equal(during.videoFiles.length, 0);
  finish();
  await building;
  const after = await service.listTimelapseFiles(camera, camera);
  assert.equal(after.videoFiles.length, 1);
  assert.equal(after.imageFiles.length, 1);
  assert.equal((await fs.readdir(root)).some((name) => name.endsWith(".partial")), false);
});

test("failed video builds remove incomplete output and release the encoder slot", async (t) => {
  const { service, root, camera } = await fixture(t, async (command, args) => {
    await fs.writeFile(args.at(-1), "incomplete");
    throw new Error("encoder_failure");
  });
  await fs.writeFile(path.join(root, "frame-first.jpg"), "image");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(service.buildTimelapseVideo(camera, camera), /encoder_failure/);
  }
  const files = await fs.readdir(root);
  assert.deepEqual(files, ["frame-first.jpg"]);
});

test("a pending archive deletion prevents a video build from consuming disappearing frames", async (t) => {
  const { service, root, camera } = await fixture(t);
  await fs.writeFile(path.join(root, "frame-first.jpg"), "image");
  const deleting = service.deleteTimelapseFile(camera, camera, "frame-first.jpg");
  await assert.rejects(service.buildTimelapseVideo(camera, camera), /timelapse_build_busy/);
  await deleting;
  await assert.rejects(service.buildTimelapseVideo(camera, camera), /no_timelapse_images/);
});

test("shutdown cancels the active video build and removes its partial file", async (t) => {
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const { service, root, camera } = await fixture(t, async (command, args, { signal }) => {
    await fs.writeFile(args.at(-1), "incomplete");
    started();
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("media_cancelled")), { once: true }));
  });
  await fs.writeFile(path.join(root, "frame-first.jpg"), "image");
  const building = service.buildTimelapseVideo(camera, camera);
  await didStart;
  const rejected = assert.rejects(building, /media_cancelled/);
  await service.stopTimelapseVideoBuilds();
  await rejected;
  assert.deepEqual(await fs.readdir(root), ["frame-first.jpg"]);
  await assert.rejects(service.buildTimelapseVideo(camera, camera), /server_stopping/);
});
