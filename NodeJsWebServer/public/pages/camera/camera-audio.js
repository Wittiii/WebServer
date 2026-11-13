import {
  deleteCameraAudioClip,
  fetchCameraAudio,
  saveCameraAudioSettings,
} from "./camera-api.js";
import { escapeHtml, formatBytes, formatTimestamp, setStatusLine } from "./camera-utils.js";

const streamVideoEl = document.getElementById("camera-stream-video");
const streamFrameEl = document.getElementById("camera-stream-frame");
const audioBarEl = document.getElementById("camera-audio-bar");
const muteBtnEl = document.getElementById("camera-audio-mute-btn");
const volumeEl = document.getElementById("camera-audio-volume");
const volumePctEl = document.getElementById("camera-audio-volume-pct");
const alarmBadgeEl = document.getElementById("camera-audio-alarm-badge");
const vuFillEl = document.getElementById("camera-vu-fill");
const vuDbEl = document.getElementById("camera-vu-db");

const audioPanelEl = document.getElementById("camera-audio-panel");
const audioRefreshEl = document.getElementById("camera-audio-refresh");
const audioFormEl = document.getElementById("camera-audio-settings-form");
const audioEnabledEl = document.getElementById("camera-audio-enabled");
const audioAutoClipEl = document.getElementById("camera-audio-autoclip");
const audioMarkersEl = document.getElementById("camera-audio-markers");
const audioThresholdEl = document.getElementById("camera-audio-threshold");
const audioCooldownEl = document.getElementById("camera-audio-cooldown");
const audioWebhookEl = document.getElementById("camera-audio-webhook");
const audioStatusEl = document.getElementById("camera-audio-status");
const audioEventsListEl = document.getElementById("camera-audio-events-list");
const audioClipsListEl = document.getElementById("camera-audio-clips-list");
const timelapseMarkersEl = document.getElementById("timelapse-audio-markers");

let activeWhepUrl = "";
let whepPc = null;
let audioCtx = null;
let analyserNode = null;
let vuRafId = 0;
let webrtcStreamActive = false;
let lastSeenEventId = null;
let loadedAudioCameraId = null;
let audioSettingsDirty = false;
let currentCameraRef = null;

function dbToPercent(db) {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

function renderVuMeter(db) {
  if (!vuFillEl || !vuDbEl) return;
  if (!Number.isFinite(db)) {
    vuFillEl.style.width = "0%";
    vuDbEl.textContent = "-- dBFS";
    return;
  }
  const pct = dbToPercent(db);
  vuFillEl.style.width = `${pct.toFixed(1)}%`;
  vuDbEl.textContent = `${db.toFixed(1)} dBFS`;
}

function stopVuLoop() {
  if (vuRafId) {
    cancelAnimationFrame(vuRafId);
    vuRafId = 0;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
    analyserNode = null;
  }
}

function startWebAudioVu(stream) {
  stopVuLoop();
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor || !stream || !stream.getAudioTracks().length) return;

  try {
    audioCtx = new AudioContextCtor();
    const source = audioCtx.createMediaStreamSource(stream);
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 1024;
    source.connect(analyserNode);

    const buffer = new Uint8Array(analyserNode.fftSize);
    const tick = () => {
      if (!analyserNode || !webrtcStreamActive) return;
      analyserNode.getByteTimeDomainData(buffer);
      let sumSq = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const norm = (buffer[i] - 128) / 128;
        sumSq += norm * norm;
      }
      const rms = Math.sqrt(sumSq / buffer.length);
      const db = rms > 1e-5 ? 20 * Math.log10(rms) : -60;
      renderVuMeter(db);
      vuRafId = requestAnimationFrame(tick);
    };
    vuRafId = requestAnimationFrame(tick);
  } catch {
    // Fall back to MQTT status/audio_db if Web Audio is unavailable.
  }
}

function updateMuteUi() {
  if (!streamVideoEl || !muteBtnEl) return;
  const muted = streamVideoEl.muted;
  muteBtnEl.textContent = muted ? "🔇 Ton aus" : "🔊 Ton an";
  muteBtnEl.classList.toggle("is-active", !muted);
}

export function disconnectAudioPlayer() {
  activeWhepUrl = "";
  webrtcStreamActive = false;
  stopVuLoop();
  if (whepPc) {
    try {
      whepPc.close();
    } catch {}
    whepPc = null;
  }
  if (streamVideoEl) {
    streamVideoEl.srcObject = null;
    streamVideoEl.hidden = true;
  }
  if (streamFrameEl) {
    streamFrameEl.hidden = false;
  }
}

async function connectWhepPlayer(whepUrl) {
  if (!streamVideoEl || !whepUrl || typeof RTCPeerConnection === "undefined") {
    return false;
  }
  if (activeWhepUrl === whepUrl && whepPc) {
    return true;
  }

  disconnectAudioPlayer();
  activeWhepUrl = whepUrl;

  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    whepPc = pc;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    const remoteStream = new MediaStream();
    pc.ontrack = (event) => {
      if (event.streams?.[0]) {
        event.streams[0].getTracks().forEach((t) => remoteStream.addTrack(t));
      } else if (event.track) {
        remoteStream.addTrack(event.track);
      }
      if (!webrtcStreamActive && remoteStream.getTracks().length > 0) {
        webrtcStreamActive = true;
        streamVideoEl.srcObject = remoteStream;
        streamVideoEl.muted = true;
        streamVideoEl.volume = Number(volumeEl?.value ?? 0.8);
        streamVideoEl.hidden = false;
        if (streamFrameEl) streamFrameEl.hidden = true;
        updateMuteUi();
        streamVideoEl.play().catch(() => {});
        startWebAudioVu(remoteStream);
      }
    };

    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        if (whepPc === pc) {
          disconnectAudioPlayer();
        }
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const response = await fetch(whepUrl, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offer.sdp,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`WHEP HTTP ${response.status}`);
    }

    const answerSdp = await response.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    return true;
  } catch {
    if (activeWhepUrl === whepUrl) {
      disconnectAudioPlayer();
    }
    return false;
  }
}

function showAudioToast(event) {
  if (!event) return;
  let toast = document.getElementById("camera-audio-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "camera-audio-toast";
    toast.className = "camera-audio-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = `🔔 ${event.label || "Geräusch-Alarm"}`;
  toast.hidden = false;
  toast.classList.add("is-visible");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove("is-visible");
    toast.hidden = true;
  }, 6000);
}

function renderEventsAndClips(cameraId, events = [], clips = []) {
  if (audioEventsListEl) {
    if (!events.length) {
      audioEventsListEl.innerHTML =
        '<li style="justify-content:center; color: var(--text-muted);">Noch keine Audio-Ereignisse</li>';
    } else {
      audioEventsListEl.innerHTML = events
        .map(
          (ev) => `
          <li>
            <div>
              <strong class="obj-name">${escapeHtml(ev.label)}</strong>
              <div class="obj-date">${escapeHtml(ev.type === "ai_classification" ? "KI-Audio" : "dB-Trigger")}${ev.db != null ? ` · ${Number(ev.db).toFixed(1)} dBFS` : ""}${ev.confidence != null ? ` · ${(Number(ev.confidence) * 100).toFixed(0)}%` : ""}</div>
            </div>
            <span class="obj-topic">${escapeHtml(formatTimestamp(ev.timestamp))}</span>
          </li>`
        )
        .join("");
    }
  }

  if (audioClipsListEl) {
    if (!clips.length) {
      audioClipsListEl.innerHTML =
        '<li style="justify-content:center; color: var(--text-muted);">Noch keine MP4-Clips gespeichert</li>';
    } else {
      audioClipsListEl.innerHTML = clips
        .map(
          (clip) => `
          <li class="camera-timelapse-file-row">
            <div>
              <strong class="obj-name">${escapeHtml(clip.name)}</strong>
              <div class="obj-date">${escapeHtml(formatBytes(clip.sizeBytes))} · ${escapeHtml(formatTimestamp(clip.modifiedAt))}</div>
            </div>
            <div class="camera-timelapse-file-actions">
              <a class="btn btn-secondary" href="${escapeHtml(clip.url)}" target="_blank" rel="noreferrer">Abspielen</a>
              <button type="button" class="btn-secondary" data-audio-clip-delete="${escapeHtml(clip.name)}">Loeschen</button>
            </div>
          </li>`
        )
        .join("");

      audioClipsListEl.querySelectorAll("[data-audio-clip-delete]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            setStatusLine(audioStatusEl, `Loesche ${btn.dataset.audioClipDelete}...`);
            const res = await deleteCameraAudioClip(cameraId, btn.dataset.audioClipDelete);
            renderEventsAndClips(cameraId, events, res.clips || []);
            setStatusLine(audioStatusEl, "Clip geloescht.");
          } catch (err) {
            setStatusLine(audioStatusEl, `Loeschen fehlgeschlagen: ${err.message}`, true);
          }
        });
      });
    }
  }
}

export async function loadCameraAudioDetails(cameraId) {
  if (!cameraId) return;
  try {
    const data = await fetchCameraAudio(cameraId);
    if (currentCameraRef?.cameraId !== cameraId) return;
    renderEventsAndClips(cameraId, data.audio?.events || [], data.clips || []);
  } catch {
    // Keep existing UI state on transient errors.
  }
}

export function renderCameraAudio(camera) {
  currentCameraRef = camera;
  const hasAudio = Boolean(camera?.capabilities?.audio);

  if (!hasAudio) {
    disconnectAudioPlayer();
    if (audioBarEl) audioBarEl.hidden = true;
    if (audioPanelEl) audioPanelEl.hidden = true;
    if (timelapseMarkersEl) timelapseMarkersEl.hidden = true;
    loadedAudioCameraId = null;
    return;
  }

  if (audioBarEl) audioBarEl.hidden = false;
  if (audioPanelEl) audioPanelEl.hidden = false;

  if (camera.stream?.urls?.webrtcWhep && camera.status?.streaming) {
    connectWhepPlayer(camera.stream.urls.webrtcWhep);
  } else if (!camera.status?.streaming) {
    disconnectAudioPlayer();
  }

  const audio = camera.audio || {};
  if (!webrtcStreamActive) {
    renderVuMeter(audio.currentDb != null ? Number(audio.currentDb) : NaN);
  }

  if (alarmBadgeEl) {
    alarmBadgeEl.hidden = !audio.activeAlarm;
  }

  const latestEvent = audio.events?.[0];
  if (latestEvent && latestEvent.id !== lastSeenEventId) {
    if (lastSeenEventId !== null) {
      showAudioToast(latestEvent);
    }
    lastSeenEventId = latestEvent.id;
  }

  if (!audioSettingsDirty && audio.settings) {
    if (audioEnabledEl) audioEnabledEl.checked = Boolean(audio.settings.enabled);
    if (audioAutoClipEl) audioAutoClipEl.checked = Boolean(audio.settings.autoClip);
    if (audioMarkersEl) audioMarkersEl.checked = Boolean(audio.settings.saveTimelapseMarkers);
    if (audioThresholdEl) audioThresholdEl.value = String(audio.settings.thresholdDb ?? -30);
    if (audioCooldownEl) audioCooldownEl.value = String(audio.settings.cooldownSeconds ?? 30);
    if (audioWebhookEl) audioWebhookEl.value = String(audio.settings.webhookUrl || "");
  }

  if (loadedAudioCameraId !== camera.cameraId) {
    loadedAudioCameraId = camera.cameraId;
    audioSettingsDirty = false;
    loadCameraAudioDetails(camera.cameraId);
  }
}

export function renderTimelapseAudioMarkers(camera, images, onJump) {
  if (!timelapseMarkersEl) return;
  const markers = camera?.audio?.markers || [];
  if (!camera?.capabilities?.audio || !markers.length || !images.length) {
    timelapseMarkersEl.hidden = true;
    timelapseMarkersEl.innerHTML = "";
    return;
  }

  const times = images.map((img) => new Date(img.modifiedAt).getTime());
  const minT = times[0];
  const maxT = times[times.length - 1];
  const span = Math.max(1, maxT - minT);

  const dots = markers
    .map((m) => {
      const mt = new Date(m.timestamp).getTime();
      if (!Number.isFinite(mt) || mt < minT - 60000 || mt > maxT + 60000) return null;
      let bestIdx = 0;
      let bestDiff = Infinity;
      for (let i = 0; i < times.length; i += 1) {
        const diff = Math.abs(times[i] - mt);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }
      const pct = Math.max(0, Math.min(100, ((mt - minT) / span) * 100));
      return { idx: bestIdx, pct, label: `${m.label} (${formatTimestamp(m.timestamp)})` };
    })
    .filter(Boolean)
    .slice(0, 30);

  if (!dots.length) {
    timelapseMarkersEl.hidden = true;
    timelapseMarkersEl.innerHTML = "";
    return;
  }

  timelapseMarkersEl.hidden = false;
  timelapseMarkersEl.innerHTML = dots
    .map(
      (dot) =>
        `<button type="button" class="timelapse-audio-marker-dot" style="left:${dot.pct.toFixed(1)}%" data-marker-idx="${dot.idx}" title="${escapeHtml(dot.label)}"></button>`
    )
    .join("");

  timelapseMarkersEl.querySelectorAll("[data-marker-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      onJump(Number(btn.dataset.markerIdx));
    });
  });
}

muteBtnEl?.addEventListener("click", async () => {
  if (!streamVideoEl) return;
  if (audioCtx && audioCtx.state === "suspended") {
    await audioCtx.resume().catch(() => {});
  }
  streamVideoEl.muted = !streamVideoEl.muted;
  if (!streamVideoEl.muted && streamVideoEl.volume === 0) {
    streamVideoEl.volume = 0.8;
    if (volumeEl) volumeEl.value = "0.8";
    if (volumePctEl) volumePctEl.textContent = "80%";
  }
  updateMuteUi();
});

volumeEl?.addEventListener("input", () => {
  const vol = Number(volumeEl.value);
  if (streamVideoEl) {
    streamVideoEl.volume = vol;
    if (vol > 0 && streamVideoEl.muted) {
      streamVideoEl.muted = false;
    }
  }
  if (volumePctEl) volumePctEl.textContent = `${Math.round(vol * 100)}%`;
  updateMuteUi();
});

audioFormEl?.addEventListener("input", () => {
  audioSettingsDirty = true;
});

audioFormEl?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentCameraRef?.cameraId) return;
  try {
    setStatusLine(audioStatusEl, "Speichere Audio-Regeln...");
    await saveCameraAudioSettings(currentCameraRef.cameraId, {
      enabled: Boolean(audioEnabledEl?.checked),
      autoClip: Boolean(audioAutoClipEl?.checked),
      saveTimelapseMarkers: Boolean(audioMarkersEl?.checked),
      thresholdDb: Number(audioThresholdEl?.value ?? -30),
      cooldownSeconds: Number(audioCooldownEl?.value ?? 30),
      webhookUrl: String(audioWebhookEl?.value || "").trim(),
    });
    audioSettingsDirty = false;
    setStatusLine(audioStatusEl, "Audio-Regeln gespeichert.");
    await loadCameraAudioDetails(currentCameraRef.cameraId);
  } catch (err) {
    setStatusLine(audioStatusEl, `Speichern fehlgeschlagen: ${err.message}`, true);
  }
});

audioRefreshEl?.addEventListener("click", () => {
  if (currentCameraRef?.cameraId) {
    loadCameraAudioDetails(currentCameraRef.cameraId);
  }
});
