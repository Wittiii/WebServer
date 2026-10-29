async function readJson(response) {
  const data = await response.json();
  if (response.status === 401 && data.error === "not_authenticated") {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
    throw new Error("session_expired");
  }
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export async function fetchCameraOverview() {
  return readJson(await fetch("/api/camera/overview", { credentials: "same-origin", signal: AbortSignal.timeout(12000) }));
}

export async function postCameraCommand(cameraId, action, body = {}) {
  return readJson(await fetch("/api/camera/command", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cameraId, action, ...body }),
  }));
}

export async function fetchCameraSnapshot(cameraId) {
  const query = new URLSearchParams({ cameraId, t: String(Date.now()) });
  const response = await fetch(`/api/camera/snapshot?${query}`, {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const data = await response.json();
      if (response.status === 401 && data.error === "not_authenticated") {
        const next = `${window.location.pathname}${window.location.search}`;
        window.location.assign(`/login?next=${encodeURIComponent(next)}`);
        throw new Error("session_expired");
      }
      if (data?.error) message = data.error;
    } catch (error) {
      if (error?.message === "session_expired") throw error;
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const timestamp = response.headers.get("X-Snapshot-Timestamp") || new Date().toISOString();
  return { blob, timestamp };
}

export async function fetchTimelapse(cameraId, offset = 0) {
  const query = new URLSearchParams({ cameraId, offset, limit: 200 });
  return readJson(await fetch(`/api/camera/timelapse?${query}`, {
    credentials: "same-origin",
    signal: AbortSignal.timeout(12000),
  }));
}

export async function buildTimelapse(cameraId) {
  return readJson(await fetch("/api/camera/timelapse/build", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cameraId }),
  }));
}

export async function deleteTimelapse(payload) {
  return readJson(await fetch("/api/camera/timelapse/delete", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }));
}
