async function readJson(response) {
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export async function fetchCameraOverview() {
  return readJson(await fetch("/api/camera/overview"));
}

export async function postCameraCommand(cameraId, action, body = {}) {
  return readJson(await fetch("/api/camera/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cameraId, action, ...body }),
  }));
}

export async function fetchTimelapse(cameraId) {
  return readJson(await fetch(`/api/camera/timelapse?cameraId=${encodeURIComponent(cameraId)}`));
}

export async function buildTimelapse(cameraId) {
  return readJson(await fetch("/api/camera/timelapse/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cameraId }),
  }));
}

export async function deleteTimelapse(payload) {
  return readJson(await fetch("/api/camera/timelapse/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }));
}
