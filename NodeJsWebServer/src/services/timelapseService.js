const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const remoteSyncJobs = new Map();

function toNumber(value, fallback) {
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
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `timelapse-${stamp}.mp4`;
}

function isWithinRoot(rootDir, candidatePath) {
  const relative = path.relative(rootDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRemoteArchive(cameraConfig) {
  return cameraConfig?.archive?.type === "remote_http";
}

function normalizeTimelapseRoot(cameraOverview, cameraConfig) {
  const rawDir = cameraConfig?.archive?.localDir
    ? cameraConfig.archive.localDir
    : isRemoteArchive(cameraConfig) || cameraConfig?.archive?.type === "server_capture"
    ? cameraConfig.archive.localDir || path.join(process.cwd(), "data", "timelapse", cameraOverview.cameraId)
    : process.env.CAMERA_PI_TIMELAPSE_DIR || cameraOverview?.timelapse?.outputDir || "";
  if (!rawDir) {
    throw new Error("timelapse_dir_unavailable");
  }
  return path.resolve(rawDir);
}

async function ensureTimelapseRoot(cameraOverview, cameraConfig) {
  const rootDir = normalizeTimelapseRoot(cameraOverview, cameraConfig);
  await fs.mkdir(rootDir, { recursive: true });
  return rootDir;
}

function getRemoteArchiveBaseUrl(cameraOverview, cameraConfig) {
  const explicit = String(cameraConfig?.archive?.baseUrl || "").replace(/\/+$/, "");
  if (explicit) return explicit;

  const reported = String(cameraOverview?.stream?.archiveUrl || "").replace(/\/+$/, "");
  if (reported) return reported;

  const ip = String(cameraOverview?.status?.ip || "").trim();
  if (!ip || ip === "-") throw new Error("remote_archive_ip_unavailable");
  return `http://${ip}:${cameraConfig?.archive?.port || 8080}`;
}

function getRemoteArchiveHeaders(cameraConfig) {
  const token = String(cameraConfig?.archive?.token || "");
  return token ? { "X-Archive-Token": token } : {};
}

function getRemoteTimeoutMs() {
  return Math.max(2000, toNumber(process.env.CAMERA_DFR1154_ARCHIVE_TIMEOUT_MS, 45000));
}

function getRemoteRetryCount() {
  return Math.max(0, toNumber(process.env.CAMERA_DFR1154_ARCHIVE_RETRIES, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRemoteSyncJob(cameraId) {
  const key = String(cameraId || "");
  let job = remoteSyncJobs.get(key);
  if (!job) {
    job = {
      cameraId: key,
      running: false,
      baseUrl: "",
      remoteCount: 0,
      downloaded: 0,
      pending: 0,
      error: "",
      updatedAt: 0,
      promise: null,
      queue: [],
      nextOffset: 0,
      hasMore: true,
      lastCompletedAt: 0,
    };
    remoteSyncJobs.set(key, job);
  }
  return job;
}

function buildRemoteSyncSnapshot(job, overrides = {}) {
  const merged = {
    ok: !job.error,
    running: job.running,
    baseUrl: job.baseUrl,
    remoteCount: job.remoteCount,
    downloaded: job.downloaded,
    pending: job.pending,
    scanned: job.remoteCount,
    queued: job.queue.length,
    scanning: job.hasMore,
    error: job.error,
    updatedAt: job.updatedAt,
    ...overrides,
  };

  return {
    ok: merged.ok,
    running: Boolean(merged.running),
    baseUrl: merged.baseUrl || "",
    remoteCount: Math.max(0, toNumber(merged.remoteCount, 0)),
    downloaded: Math.max(0, toNumber(merged.downloaded, 0)),
    pending: Math.max(0, toNumber(merged.pending, 0)),
    scanned: Math.max(0, toNumber(merged.scanned, 0)),
    queued: Math.max(0, toNumber(merged.queued, 0)),
    scanning: Boolean(merged.scanning),
    error: merged.error || "",
    updatedAt: merged.updatedAt ? new Date(merged.updatedAt).toISOString() : null,
  };
}

function getRemoteSyncLimit() {
  return Math.min(1, Math.max(1, toNumber(process.env.CAMERA_DFR1154_SYNC_MAX_FILES, 1)));
}

function getRemoteDownloadPauseMs() {
  return Math.max(2000, toNumber(process.env.CAMERA_DFR1154_SYNC_PAUSE_MS, 2000));
}

function getRemoteListPageSize() {
  return Math.min(100, Math.max(10, toNumber(process.env.CAMERA_DFR1154_LIST_PAGE_SIZE, 50)));
}

function getRemoteRescanIntervalMs() {
  return Math.max(10000, toNumber(process.env.CAMERA_DFR1154_RESCAN_INTERVAL_MS, 60000));
}

function validRemoteImageName(name) {
  const normalized = String(name || "");
  return /^frame-[A-Za-z0-9-]+\.jpe?g$/i.test(normalized);
}

async function fetchRemote(url, cameraConfig, options = {}) {
  const maxAttempts = getRemoteRetryCount() + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...getRemoteArchiveHeaders(cameraConfig),
          ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(getRemoteTimeoutMs()),
      });
      if (!response.ok) {
        throw new Error(`remote_archive_http_${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      const isTimeout =
        error?.name === "TimeoutError" ||
        error?.name === "AbortError" ||
        /aborted due to timeout/i.test(message);

      if (!isTimeout || attempt >= maxAttempts) break;
      await sleep(500 * attempt);
    }
  }

  const lastMessage = String(lastError?.message || lastError || "unknown");
  if (
    lastError?.name === "TimeoutError" ||
    lastError?.name === "AbortError" ||
    /aborted due to timeout/i.test(lastMessage)
  ) {
    throw new Error("remote_archive_timeout");
  }
  throw lastError;
}

async function localFileMatches(filePath, expectedSize) {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() && stats.size === expectedSize;
  } catch {
    return false;
  }
}

async function downloadRemoteImage(baseUrl, remoteFile, rootDir, cameraConfig) {
  const targetPath = path.join(rootDir, remoteFile.name);
  const response = await fetchRemote(
    `${baseUrl}/api/timelapse/file?name=${encodeURIComponent(remoteFile.name)}`,
    cameraConfig
  );
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length !== remoteFile.sizeBytes) {
    throw new Error(`remote_archive_size_mismatch_${remoteFile.name}`);
  }

  const temporaryPath = `${targetPath}.part`;
  await fs.writeFile(temporaryPath, data);
  await fs.unlink(targetPath).catch(() => {});
  await fs.rename(temporaryPath, targetPath);

  if (remoteFile.modifiedEpoch > 0) {
    const modifiedAt = new Date(remoteFile.modifiedEpoch * 1000);
    await fs.utimes(targetPath, modifiedAt, modifiedAt).catch(() => {});
  }
}

async function syncRemoteArchivePass(cameraOverview, cameraConfig, rootDir, job) {
  const baseUrl = getRemoteArchiveBaseUrl(cameraOverview, cameraConfig);
  job.baseUrl = baseUrl;

  if (job.queue.length === 0 && job.hasMore) {
    const pageSize = getRemoteListPageSize();
    const listingUrl = new URL(`${baseUrl}/api/timelapse`);
    listingUrl.searchParams.set("offset", String(job.nextOffset));
    listingUrl.searchParams.set("limit", String(pageSize));
    const response = await fetchRemote(listingUrl.toString(), cameraConfig);
    const payload = await response.json();
    if (!payload?.ok || !Array.isArray(payload.files)) {
      throw new Error("remote_archive_invalid_listing");
    }

    const remoteFiles = payload.files
      .filter((file) => validRemoteImageName(file?.name))
      .map((file) => ({
        name: String(file.name),
        sizeBytes: Math.max(0, toNumber(file.sizeBytes, 0)),
        modifiedEpoch: Math.max(0, toNumber(file.modifiedEpoch, 0)),
      }));

    for (const remoteFile of remoteFiles) {
      if (!(await localFileMatches(path.join(rootDir, remoteFile.name), remoteFile.sizeBytes))) {
        job.queue.push(remoteFile);
      }
    }

    job.remoteCount += remoteFiles.length;
    job.nextOffset = Math.max(
      job.nextOffset + remoteFiles.length,
      toNumber(payload.nextOffset, job.nextOffset + remoteFiles.length)
    );
    job.hasMore = payload.hasMore === true;
    console.log(
      `[TimelapseSync:${job.cameraId}] scanned=${job.remoteCount} queued=${job.queue.length} hasMore=${job.hasMore}`
    );
  }

  const selected = job.queue.slice(0, getRemoteSyncLimit());
  let downloaded = 0;
  for (const remoteFile of selected) {
    await downloadRemoteImage(baseUrl, remoteFile, rootDir, cameraConfig);
    job.queue.shift();
    downloaded += 1;
    job.downloaded += 1;
    if (getRemoteDownloadPauseMs() > 0) {
      await sleep(getRemoteDownloadPauseMs());
    }
  }

  job.pending = job.queue.length;
  job.error = "";
  job.updatedAt = Date.now();

  return {
    ok: true,
    baseUrl,
    remoteCount: job.remoteCount,
    downloaded,
    pending: job.pending,
    hasMore: job.hasMore,
  };
}

function startRemoteSyncLoop(cameraOverview, cameraConfig, rootDir, job) {
  if (job.running) return job.promise;

  job.running = true;
  job.error = "";
  job.remoteCount = 0;
  job.downloaded = 0;
  job.pending = 0;
  job.queue = [];
  job.nextOffset = 0;
  job.hasMore = true;
  job.updatedAt = Date.now();
  console.log(`[TimelapseSync:${job.cameraId}] started`);
  job.promise = (async () => {
    try {
      while (true) {
        const result = await syncRemoteArchivePass(cameraOverview, cameraConfig, rootDir, job);
        if (result.pending <= 0 && !result.hasMore) break;
        await sleep(getRemoteDownloadPauseMs());
      }
      job.lastCompletedAt = Date.now();
      console.log(
        `[TimelapseSync:${job.cameraId}] complete scanned=${job.remoteCount} downloaded=${job.downloaded}`
      );
    } catch (error) {
      job.error = String(error?.message || error);
      job.updatedAt = Date.now();
      console.error(`[TimelapseSync:${job.cameraId}] failed: ${job.error}`);
    } finally {
      job.running = false;
      job.updatedAt = Date.now();
      job.promise = null;
    }
  })();

  return job.promise;
}

async function ensureRemoteArchiveSync(cameraOverview, cameraConfig, rootDir) {
  const job = getRemoteSyncJob(cameraOverview.cameraId);
  if (job.running) return buildRemoteSyncSnapshot(job);

  if (job.lastCompletedAt && Date.now() - job.lastCompletedAt < getRemoteRescanIntervalMs()) {
    return buildRemoteSyncSnapshot(job, { ok: true, running: false });
  }

  startRemoteSyncLoop(cameraOverview, cameraConfig, rootDir, job);
  return buildRemoteSyncSnapshot(job, { ok: true, running: true, error: "" });
}

function sanitizeFileEntry(cameraId, file) {
  const { absolutePath, ...safe } = file;
  return {
    ...safe,
    url: `/api/camera/timelapse/file?cameraId=${encodeURIComponent(cameraId)}&name=${encodeURIComponent(file.name)}`,
  };
}

async function listTimelapseFiles(cameraOverview, cameraConfig, options = {}) {
  const rootDir = await ensureTimelapseRoot(cameraOverview, cameraConfig);
  let sync = null;
  if (isRemoteArchive(cameraConfig) && options.syncRemote !== false) {
    sync = await ensureRemoteArchiveSync(cameraOverview, cameraConfig, rootDir);
  }
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (![".jpg", ".jpeg", ".mp4"].includes(ext)) continue;

    const absolutePath = path.join(rootDir, entry.name);
    const stats = await fs.stat(absolutePath);
    files.push({
      name: entry.name,
      type: ext === ".mp4" ? "video" : "image",
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      absolutePath,
    });
  }

  files.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

  const videoFiles = files.filter((file) => file.type === "video");
  const imageFiles = files.filter((file) => file.type === "image");

  return {
    rootDir,
    sync,
    files,
    safeFiles: files.map((file) => sanitizeFileEntry(cameraOverview.cameraId, file)),
    videoFiles,
    imageFiles,
    latestVideo: videoFiles[0] ? sanitizeFileEntry(cameraOverview.cameraId, videoFiles[0]) : null,
    latestImage: imageFiles[0] ? sanitizeFileEntry(cameraOverview.cameraId, imageFiles[0]) : null,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
  };
}

async function spawnAndWait(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `command_failed_${code}`));
    });
  });
}

async function buildTimelapseVideo(cameraOverview, cameraConfig) {
  const listing = await listTimelapseFiles(cameraOverview, cameraConfig);
  if (isRemoteArchive(cameraConfig) && listing.sync?.ok === false) {
    throw new Error(`remote_archive_sync_failed: ${listing.sync.error}`);
  }
  if (isRemoteArchive(cameraConfig) && (listing.sync?.running || listing.sync?.scanning)) {
    throw new Error("remote_archive_sync_incomplete: synchronization is still running");
  }
  if (isRemoteArchive(cameraConfig) && listing.sync?.pending > 0) {
    throw new Error(`remote_archive_sync_incomplete: ${listing.sync.pending} files pending`);
  }
  if (listing.imageFiles.length === 0) {
    throw new Error("no_timelapse_images");
  }

  const outputPath = path.join(listing.rootDir, getTimelapseVideoName());
  const inputPattern = path.join(listing.rootDir, "frame-*.jpg");

  await spawnAndWait(getFfmpegPath(), [
    "-y",
    "-hide_banner",
    "-loglevel",
    "warning",
    "-pattern_type",
    "glob",
    "-framerate",
    String(getOutputVideoFps()),
    "-i",
    inputPattern,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
}

async function deleteRemoteImage(cameraOverview, cameraConfig, name) {
  const baseUrl = getRemoteArchiveBaseUrl(cameraOverview, cameraConfig);
  await fetchRemote(
    `${baseUrl}/api/timelapse/file?name=${encodeURIComponent(name)}`,
    cameraConfig,
    { method: "DELETE" }
  );
}

async function deleteAllRemoteImages(cameraOverview, cameraConfig) {
  const baseUrl = getRemoteArchiveBaseUrl(cameraOverview, cameraConfig);
  await fetchRemote(`${baseUrl}/api/timelapse`, cameraConfig, { method: "DELETE" });
}

async function deleteTimelapseFile(cameraOverview, cameraConfig, name) {
  const rootDir = await ensureTimelapseRoot(cameraOverview, cameraConfig);
  const absolutePath = path.resolve(path.join(rootDir, String(name || "")));
  if (!isWithinRoot(rootDir, absolutePath)) {
    throw new Error("invalid_timelapse_path");
  }
  if (isRemoteArchive(cameraConfig) && /\.jpe?g$/i.test(String(name || ""))) {
    await deleteRemoteImage(cameraOverview, cameraConfig, String(name));
  }
  await fs.unlink(absolutePath);
}

async function deleteTimelapseByType(cameraOverview, cameraConfig, type) {
  if (isRemoteArchive(cameraConfig) && type === "image") {
    await deleteAllRemoteImages(cameraOverview, cameraConfig);
  }
  const listing = await listTimelapseFiles(cameraOverview, cameraConfig, { syncRemote: false });
  const normalizedType = type === "video" ? "video" : "image";
  const targets = listing.files.filter((file) => file.type === normalizedType);
  for (const target of targets) {
    await fs.unlink(target.absolutePath);
  }
  return targets.length;
}

async function resolveTimelapseFilePath(cameraOverview, cameraConfig, name) {
  const rootDir = await ensureTimelapseRoot(cameraOverview, cameraConfig);
  const absolutePath = path.resolve(path.join(rootDir, String(name || "")));
  if (!isWithinRoot(rootDir, absolutePath)) {
    throw new Error("invalid_timelapse_path");
  }
  return absolutePath;
}

module.exports = {
  buildTimelapseVideo,
  deleteTimelapseByType,
  deleteTimelapseFile,
  listTimelapseFiles,
  resolveTimelapseFilePath,
};
