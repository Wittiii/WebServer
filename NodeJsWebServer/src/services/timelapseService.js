const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

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

function normalizeTimelapseRoot(cameraOverview) {
  const rawDir = cameraOverview?.timelapse?.outputDir || process.env.CAMERA_PI_TIMELAPSE_DIR || "";
  if (!rawDir) {
    throw new Error("timelapse_dir_unavailable");
  }
  return path.resolve(rawDir);
}

async function ensureTimelapseRoot(cameraOverview) {
  const rootDir = normalizeTimelapseRoot(cameraOverview);
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

async function listTimelapseFiles(cameraOverview) {
  const rootDir = await ensureTimelapseRoot(cameraOverview);
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

async function buildTimelapseVideo(cameraOverview) {
  const listing = await listTimelapseFiles(cameraOverview);
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

async function deleteTimelapseFile(cameraOverview, name) {
  const rootDir = await ensureTimelapseRoot(cameraOverview);
  const absolutePath = path.resolve(path.join(rootDir, String(name || "")));
  if (!isWithinRoot(rootDir, absolutePath)) {
    throw new Error("invalid_timelapse_path");
  }
  await fs.unlink(absolutePath);
}

async function deleteTimelapseByType(cameraOverview, type) {
  const listing = await listTimelapseFiles(cameraOverview);
  const normalizedType = type === "video" ? "video" : "image";
  const targets = listing.files.filter((file) => file.type === normalizedType);
  for (const target of targets) {
    await fs.unlink(target.absolutePath);
  }
  return targets.length;
}

async function resolveTimelapseFilePath(cameraOverview, name) {
  const rootDir = await ensureTimelapseRoot(cameraOverview);
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
