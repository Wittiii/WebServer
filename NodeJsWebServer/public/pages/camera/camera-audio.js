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
const pttBtnEl = document.getElementById("camera-intercom-ptt");
const intercomStatusEl = document.getElementById("camera-intercom-status");
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

async function connectWhepPlayer(whepUrl, cameraId) {
  if (!streamVideoEl || (!whepUrl && !cameraId) || typeof RTCPeerConnection === "undefined") {
    return false;
  }
  const sessionKey = `${cameraId || ""}|${whepUrl || ""}`;
  if (activeWhepUrl === sessionKey && whepPc) {
    return true;
  }

  disconnectAudioPlayer();
  activeWhepUrl = sessionKey;

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

    let response = null;
    if (cameraId) {
      response = await fetch(`/api/camera/whep?cameraId=${encodeURIComponent(cameraId)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp,
        signal: AbortSignal.timeout(8000),
      }).catch(() => null);
    }

    if ((!response || !response.ok) && whepUrl && window.location.protocol !== "https:") {
      response = await fetch(whepUrl, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp,
        signal: AbortSignal.timeout(5000),
      });
    }

    if (!response || !response.ok) {
      throw new Error(`WHEP HTTP ${response?.status || "failed"}`);
    }

    const answerSdp = await response.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    return true;
  } catch {
    if (activeWhepUrl === sessionKey) {
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
    stopIntercom();
    if (audioBarEl) audioBarEl.hidden = true;
    if (pttBtnEl) pttBtnEl.hidden = true;
    if (audioPanelEl) audioPanelEl.hidden = true;
    if (timelapseMarkersEl) timelapseMarkersEl.hidden = true;
    loadedAudioCameraId = null;
    if (window.location.protocol === "https:" && camera?.status?.streaming && camera?.stream?.urls?.webrtcWhep) {
      connectWhepPlayer(camera.stream.urls.webrtcWhep, camera.cameraId);
    } else {
      disconnectAudioPlayer();
    }
    return;
  }

  if (audioBarEl) audioBarEl.hidden = false;
  if (pttBtnEl) pttBtnEl.hidden = !camera?.capabilities?.intercom;
  if (audioPanelEl) audioPanelEl.hidden = false;

  if (camera.stream?.urls?.webrtcWhep && camera.status?.streaming) {
    connectWhepPlayer(camera.stream.urls.webrtcWhep, camera.cameraId);
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

// --- Push-to-Talk Intercom (32000 Hz Mono s16le over WebSocket -> ESP32 TCP:3234) ---
let intercomActive = false;
let intercomWs = null;
let intercomCtx = null;
let intercomStream = null;
let intercomNode = null;
let intercomSource = null;
let wasMutedBeforePtt = true;

function setIntercomStatus(text, isError = false) {
  if (!intercomStatusEl) return;
  intercomStatusEl.textContent = text;
  intercomStatusEl.hidden = !text;
  intercomStatusEl.classList.toggle("is-error", Boolean(isError));
}

function stopIntercom() {
  const wasActive = intercomActive;
  intercomActive = false;

  if (pttBtnEl) {
    pttBtnEl.classList.remove("is-talking");
    pttBtnEl.textContent = "🎙️ Sprechen (gedrueckt halten)";
  }

  if (wasActive && streamVideoEl && !wasMutedBeforePtt) {
    streamVideoEl.muted = false;
    updateMuteUi();
  }

  if (intercomNode) {
    try {
      intercomNode.disconnect();
    } catch {}
    intercomNode = null;
  }
  if (intercomSource) {
    try {
      intercomSource.disconnect();
    } catch {}
    intercomSource = null;
  }
  if (intercomCtx) {
    intercomCtx.close().catch(() => {});
    intercomCtx = null;
  }
  if (intercomStream) {
    intercomStream.getTracks().forEach((t) => t.stop());
    intercomStream = null;
  }
  if (intercomWs) {
    try {
      if (intercomWs.readyState <= 1) intercomWs.close();
    } catch {}
    intercomWs = null;
  }
}

async function startIntercom() {
  if (intercomActive || !currentCameraRef?.capabilities?.intercom) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    setIntercomStatus("Mikrofon erfordert HTTPS oder localhost.", true);
    return;
  }

  intercomActive = true;
  if (pttBtnEl) {
    pttBtnEl.classList.add("is-talking");
    pttBtnEl.textContent = "🔴 Mikrofon aktiv...";
  }
  setIntercomStatus("Verbinde Gegensprechanlage...");

  // Temporarily mute local camera playback during PTT to prevent acoustic feedback.
  if (streamVideoEl) {
    wasMutedBeforePtt = streamVideoEl.muted;
    if (!streamVideoEl.muted) {
      streamVideoEl.muted = true;
      updateMuteUi();
    }
  }

  try {
    intercomStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (!intercomActive) {
      stopIntercom();
      return;
    }

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/ws/camera/intercom?cameraId=${encodeURIComponent(
      currentCameraRef.cameraId
    )}`;
    intercomWs = new WebSocket(wsUrl);
    intercomWs.binaryType = "arraybuffer";

    intercomWs.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "ready") {
          setIntercomStatus(`🎙️ Live (${msg.host}:${msg.port})`);
        } else if (msg.type === "error") {
          setIntercomStatus(msg.message || "Gegensprech-Fehler", true);
          stopIntercom();
        } else if (msg.type === "closed") {
          stopIntercom();
        }
      } catch {}
    };

    intercomWs.onerror = () => {
      setIntercomStatus("WebSocket-Fehler zur Gegensprechanlage", true);
      stopIntercom();
    };

    intercomWs.onclose = () => {
      if (intercomActive) stopIntercom();
    };

    await new Promise((resolve, reject) => {
      if (!intercomWs) return reject(new Error("ws_closed"));
      intercomWs.addEventListener("open", resolve, { once: true });
      intercomWs.addEventListener("error", () => reject(new Error("ws_connect_failed")), { once: true });
    });

    if (!intercomActive) {
      stopIntercom();
      return;
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    intercomCtx = new AudioContextCtor();
    intercomSource = intercomCtx.createMediaStreamSource(intercomStream);

    if (intercomCtx.audioWorklet) {
      await intercomCtx.audioWorklet.addModule("/pages/camera/camera-intercom-worklet.js");
      if (!intercomActive) {
        stopIntercom();
        return;
      }
      intercomNode = new AudioWorkletNode(intercomCtx, "intercom-capture-processor");
      intercomNode.port.onmessage = (event) => {
        if (intercomActive && intercomWs?.readyState === WebSocket.OPEN && event.data) {
          intercomWs.send(event.data);
        }
      };
      intercomSource.connect(intercomNode);
      intercomNode.connect(intercomCtx.destination);
    } else {
      // Fallback for browsers without AudioWorklet
      const processor = intercomCtx.createScriptProcessor(2048, 1, 1);
      const srcRate = intercomCtx.sampleRate || 48000;
      const step = srcRate / 32000;
      processor.onaudioprocess = (e) => {
        if (!intercomActive || intercomWs?.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const outLen = Math.floor(input.length / step);
        const pcm = new Int16Array(outLen);
        for (let i = 0; i < outLen; i += 1) {
          const sample = Math.max(-1, Math.min(1, input[Math.floor(i * step)]));
          pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        intercomWs.send(pcm.buffer);
      };
      intercomSource.connect(processor);
      processor.connect(intercomCtx.destination);
      intercomNode = processor;
    }
  } catch (err) {
    setIntercomStatus(`Mikrofon/Stream fehlgeschlagen: ${err?.message || "unbekannt"}`, true);
    stopIntercom();
  }
}

pttBtnEl?.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (pttBtnEl.setPointerCapture) {
    try { pttBtnEl.setPointerCapture(e.pointerId); } catch {}
  }
  startIntercom();
});
pttBtnEl?.addEventListener("pointerup", () => {
  stopIntercom();
  setIntercomStatus("");
});
pttBtnEl?.addEventListener("pointercancel", () => {
  stopIntercom();
  setIntercomStatus("");
});
window.addEventListener("blur", () => {
  if (intercomActive) stopIntercom();
});
