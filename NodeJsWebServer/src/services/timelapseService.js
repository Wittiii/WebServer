const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("node:crypto");
const { getMediaThreads, runMediaProcess } = require("./mediaProcessService");

const listings = new Map();
const scans = new Map();
const archiveMutations = new Set();
let activeBuild = null;
let stopping = false;

function toNumber(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getFfmpegPath() {
  return process.env.TIMELAPSE_FFMPEG_PATH || "ffmpeg";
}

function getOutputVideoFps() {
  return Math.max(1, toNumber(process.env.TIMELAPSE_VIDEO_FPS, 20));
}

function getTimelapseVideoName() {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate()
  ).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(
    now.getMinutes()
  ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  return `timelapse-${stamp}-${randomUUID().slice(0, 8)}.mp4`;
}

function isWithinRoot(rootDir, candidatePath) {
  const relative = path.relative(rootDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeTimelapseRoot(cameraOverview, cameraConfig) {
  const configured = String(cameraConfig?.archive?.localDir || "").trim();
  return path.resolve(
    configured || path.join(process.cwd(), "data", "timelapse", cameraOverview.cameraId)
  );
}

async function ensureTimelapseRoot(cameraOverview, cameraConfig) {
  const rootDir = normalizeTimelapseRoot(cameraOverview, cameraConfig);
  await fs.mkdir(rootDir, { recursive: true });
  return rootDir;
}

function sanitizeFileEntry(cameraId, file) {
  const { absolutePath, ...safe } = file;
  return {
    ...safe,
    url: `/api/camera/timelapse/file?cameraId=${encodeURIComponent(cameraId)}&name=${encodeURIComponent(file.name)}`,
  };
}

async function scanTimelapseFiles(cameraOverview, cameraConfig) {
  const rootDir = await ensureTimelapseRoot(cameraOverview, cameraConfig);
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (![".jpg", ".jpeg", ".mp4"].includes(extension)) continue;
    const absolutePath = path.join(rootDir, entry.name);
    const stats = await fs.lstat(absolutePath).catch((error) => {
      if (error.code === "ENOENT") return null; // A user may delete a frame during a scan.
      throw error;
    });
    if (!stats?.isFile()) continue;
    files.push({
      name: entry.name,
      type: extension === ".mp4" ? "video" : "image",
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      absolutePath,
    });
  }

  // ISO timestamps sort chronologically without allocating Dates per comparison.
  files.sort((left, right) => left.modifiedAt === right.modifiedAt ? 0 : left.modifiedAt < right.modifiedAt ? 1 : -1);
  const videoFiles = files.filter((file) => file.type === "video");
  const imageFiles = files.filter((file) => file.type === "image");
  return {
    rootDir,
    sync: null,
    files,
    safeFiles: files.map((file) => sanitizeFileEntry(cameraOverview.cameraId, file)),
    videoFiles,
    imageFiles,
    latestVideo: videoFiles[0] ? sanitizeFileEntry(cameraOverview.cameraId, videoFiles[0]) : null,
    latestImage: imageFiles[0] ? sanitizeFileEntry(cameraOverview.cameraId, imageFiles[0]) : null,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
  };
}

async function listTimelapseFiles(cameraOverview, cameraConfig, { fresh = false } = {}) {
  const rootDir = normalizeTimelapseRoot(cameraOverview, cameraConfig);
  // Share one disk walk between camera polling and the capture supervisor.
  if (scans.has(rootDir)) return scans.get(rootDir);
  const cached = listings.get(rootDir);
  const cacheMs = Math.max(1000, toNumber(process.env.TIMELAPSE_ARCHIVE_SCAN_MS, 300000));
  if (!fresh && cached && Date.now() - cached.createdAt < cacheMs) return cached.listing;
  const scan = scanTimelapseFiles(cameraOverview, cameraConfig).then((listing) => {
    if (listings.size >= 16 && !listings.has(rootDir)) listings.delete(listings.keys().next().value);
    listings.set(rootDir, { createdAt: Date.now(), listing });
    return listing;
  }).finally(() => scans.delete(rootDir));
  scans.set(rootDir, scan);
  return scan;
}

async function invalidateTimelapseFiles(cameraOverview, cameraConfig) {
  const rootDir = normalizeTimelapseRoot(cameraOverview, cameraConfig);
  // Do not allow an older in-flight scan to repopulate a deleted-file snapshot.
  await scans.get(rootDir)?.catch(() => {});
  listings.delete(rootDir);
}

async function recordTimelapseFrame(cameraOverview, cameraConfig, name, stats) {
  const rootDir = normalizeTimelapseRoot(cameraOverview, cameraConfig);
  // A scan may already have observed the newly renamed image.
  await scans.get(rootDir);
  const listing = listings.get(rootDir)?.listing;
  if (!listing || listing.imageFiles.some((file) => file.name === name)) return;
  const file = {
    name, type: "image", sizeBytes: stats.size, modifiedAt: stats.mtime.toISOString(),
    absolutePath: path.join(rootDir, name),
  };
  listing.files.unshift(file);
  listing.imageFiles.unshift(file);
  const safe = sanitizeFileEntry(cameraOverview.cameraId, file);
  listing.safeFiles.unshift(safe);
  listing.latestImage = safe;
  listing.totalBytes += file.sizeBytes;
}

async function buildTimelapseVideo(cameraOverview, cameraConfig) {
  if (stopping) throw new Error("server_stopping");
  const rootDir = normalizeTimelapseRoot(cameraOverview, cameraConfig);
  if (activeBuild || archiveMutations.has(rootDir)) throw new Error("timelapse_build_busy");
  const job = { controller: new AbortController(), rootDir };
  activeBuild = job;
  job.promise = (async () => {
    const listing = await listTimelapseFiles(cameraOverview, cameraConfig, { fresh: true });
    if (!listing.imageFiles.some((file) => /^frame-.*\.jpg$/.test(file.name))) {
      throw new Error("no_timelapse_images");
    }
    const outputPath = path.join(listing.rootDir, getTimelapseVideoName());
    const temporaryPath = `${outputPath}.partial`;
    try {
      const threads = String(getMediaThreads(process.env.TIMELAPSE_FFMPEG_THREADS));
      await runMediaProcess(getFfmpegPath(), [
        "-y", "-nostdin", "-hide_banner", "-loglevel", "warning",
        "-threads", threads, "-filter_threads", "1",
        "-pattern_type", "glob", "-framerate", String(getOutputVideoFps()),
        "-i", path.join(listing.rootDir, "frame-*.jpg"),
        "-c:v", "libx264", "-threads", threads, "-preset", "veryfast",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", temporaryPath,
      ], {
        timeoutMs: Math.max(1000, toNumber(process.env.TIMELAPSE_BUILD_TIMEOUT_MS, 30 * 60 * 1000)),
        timeoutError: "timelapse_build_timeout",
        signal: job.controller.signal,
      });
      await fs.rename(temporaryPath, outputPath);
    } finally {
      await fs.unlink(temporaryPath).catch((error) => {
        if (error.code !== "ENOENT") console.warn(`[Timelapse] temporary file cleanup: ${error.message}`);
      });
      await invalidateTimelapseFiles(cameraOverview, cameraConfig);
    }
  })();
  try { await job.promise; } finally { activeBuild = null; }
}

async function stopTimelapseVideoBuilds() {
  stopping = true;
  const job = activeBuild;
  job?.controller.abort();
  await job?.promise?.catch(() => {});
}

async function deleteTimelapseFile(cameraOverview, cameraConfig, name) {
  const rootDir = normalizeTimelapseRoot(cameraOverview, cameraConfig);
  if (activeBuild?.rootDir === rootDir || archiveMutations.has(rootDir)) throw new Error("timelapse_build_busy");
  archiveMutations.add(rootDir);
  try {
    const absolutePath = await resolveTimelapseFilePath(cameraOverview, cameraConfig, name);
    await fs.unlink(absolutePath);
  } finally {
    await invalidateTimelapseFiles(cameraOverview, cameraConfig);
    archiveMutations.delete(rootDir);
  }
}

async function deleteTimelapseByType(cameraOverview, cameraConfig, type) {
  const rootDir = normalizeTimelapseRoot(cameraOverview, cameraConfig);
  if (activeBuild?.rootDir === rootDir || archiveMutations.has(rootDir)) throw new Error("timelapse_build_busy");
  if (type !== "video" && type !== "image") throw new Error("invalid_delete_target");
  archiveMutations.add(rootDir);
  try {
    const listing = await listTimelapseFiles(cameraOverview, cameraConfig, { fresh: true });
    const targets = listing.files.filter((file) => file.type === type);
    for (const target of targets) await fs.unlink(target.absolutePath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return targets.length;
  } finally {
    await invalidateTimelapseFiles(cameraOverview, cameraConfig);
    archiveMutations.delete(rootDir);
  }
}

async function resolveTimelapseFilePath(cameraOverview, cameraConfig, name) {
  const rootDir = await ensureTimelapseRoot(cameraOverview, cameraConfig);
  const fileName = String(name || "");
  if (!fileName || /[\\/]/.test(fileName) || !/\.(?:jpe?g|mp4)$/i.test(fileName)) {
    throw new Error("invalid_timelapse_path");
  }
  const absolutePath = path.resolve(rootDir, fileName);
  if (!isWithinRoot(rootDir, absolutePath)) throw new Error("invalid_timelapse_path");
  const stats = await fs.lstat(absolutePath);
  if (!stats.isFile()) throw new Error("invalid_timelapse_path");
  return absolutePath;
}

module.exports = {
  buildTimelapseVideo,
  deleteTimelapseByType,
  deleteTimelapseFile,
  listTimelapseFiles,
  invalidateTimelapseFiles,
  recordTimelapseFrame,
  resolveTimelapseFilePath,
  stopTimelapseVideoBuilds,
};
