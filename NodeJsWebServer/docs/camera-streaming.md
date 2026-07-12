# Kamera Streaming mit MediaMTX

## Zielaufbau

- Raspberry Pi erzeugt den Videostream und published ihn zu MediaMTX.
- MediaMTX laeuft parallel zum Node-Webserver auf demselben Server.
- Der Node-Webserver stellt die `/camera`-Seite, MQTT-Steuerung und Statusdaten bereit.
- Browser lesen den Stream ueber MediaMTX, bevorzugt per WebRTC.
- ESP32/ESP32-S3 koennen optional per RTSP(MJPEG) einspeisen; der Node-Webserver startet dafuer bei Bedarf automatisch einen lokalen FFmpeg-Bridge-Prozess nach H264.

## Rollen

- Node-Webserver:
  - `/camera` Seite
  - `/api/camera/*` Endpunkte
  - MQTT Publish fuer Start, Stop, Restart und Parameter
  - Statusanzeige aus MQTT Topics
  - Zeitraffer-Snapshots direkt aus MediaMTX fuer Pi und DFR1154
- MediaMTX:
  - Stream-Annahme
  - Ausgabe als WebRTC, HLS und RTSP
- Raspberry Pi:
  - `rpicam-vid`
  - Publish per FFmpeg an MediaMTX
  - keine lokale Zeitrafferspeicherung
- ESP32:
  - liefert RTSP(MJPEG)
  - wird bei erkanntem MQTT-Status automatisch lokal nach H264 fuer MediaMTX transcodiert

## Wichtige Umgebungsvariablen

Diese Werte sind optional. Ohne Angabe nutzt die Kamera-Seite Default-Werte fuer einen lokalen Server:

- `CAMERA_ID=pi-zero-01`
- `CAMERA_TOPIC_BASE=camera/pi-zero-01`
- `CAMERA_MQTT_CLIENT_ID=pi-zero-01`
- `CAMERA_STREAM_PATH=pi-zero-01`
- `MEDIA_MTX_PUBLIC_HOST=192.168.x.x`
- `MEDIA_MTX_WEBRTC_PORT=8889`
- `MEDIA_MTX_HLS_PORT=8888`
- `MEDIA_MTX_RTSP_PORT=8554`
- `MEDIA_MTX_API_ENABLED=true`
- `MEDIA_MTX_API_PORT=9997`
- `MEDIA_MTX_INTERNAL_HOST=127.0.0.1`
- `CAMERA_ESP32_ID=esp32-cam-01`
- `CAMERA_ESP32_TOPIC_BASE=camera/esp32-cam-01`
- `CAMERA_ESP32_MQTT_CLIENT_ID=esp32-cam-01`
- `CAMERA_ESP32_STREAM_PATH=esp32-cam-01`
- `CAMERA_DFR1154_ID=dfr1154-cam-01`
- `CAMERA_DFR1154_TOPIC_BASE=camera/dfr1154-cam-01`
- `CAMERA_DFR1154_MQTT_CLIENT_ID=dfr1154-cam-01`
- `CAMERA_DFR1154_STREAM_PATH=dfr1154-cam-01`
- `CAMERA_DFR1154_TIMELAPSE_DIR=` Serverordner; Standard ist `data/timelapse/dfr1154-cam-01`
- `CAMERA_DFR1154_TIMELAPSE_ENABLED=true`
- `CAMERA_DFR1154_TIMELAPSE_INTERVAL_SECONDS=60`
- `CAMERA_DFR1154_TIMELAPSE_LIMIT_GB=22`
- `ESP32_TRANSCODE_ENABLED=true`
- `ESP32_TRANSCODE_FFMPEG_PATH=ffmpeg`
- `ESP32_SOURCE_RTSP_TRANSPORT=tcp`
- `ESP32_TRANSCODE_PRESET=ultrafast`
- `ESP32_TRANSCODE_TUNE=zerolatency`
- `CAMERA_PI_TIMELAPSE_DIR=` Serverordner; Standard ist `data/timelapse/pi-zero-01`
- `CAMERA_PI_TIMELAPSE_ENABLED=true`
- `CAMERA_PI_TIMELAPSE_INTERVAL_SECONDS=60`
- `CAMERA_PI_TIMELAPSE_LIMIT_GB=22`
- `CAMERA_TIMELAPSE_MIN_FREE_GB=5`
- `CAMERA_TIMELAPSE_TOTAL_LIMIT_GB=0` (`0` deaktiviert nur das Gesamtlimit)
- `TIMELAPSE_FFMPEG_PATH=ffmpeg`
- `TIMELAPSE_VIDEO_FPS=20`

## Beispiel MediaMTX

Siehe [mediamtx.camera.example.yml](C:/Users/paulw/OneDrive/Desktop/NodejsWebServer/NodeJsWebServer/docs/mediamtx.camera.example.yml).

## ESP32 Auto-Bridge

Der Webserver beobachtet fuer die ESP32-Kamera folgende MQTT-Statuswerte:

- `camera/<id>/status/online`
- `camera/<id>/status/ip`
- `camera/<id>/status/rtsp_url`
- `camera/<id>/status/config`

Sobald die Kamera online ist und eine RTSP-Quelle meldet, startet der Server automatisch diese Kette:

```text
ESP32 RTSP (MJPEG) -> FFmpeg -> MediaMTX RTSP (H264)
```

Die `/camera`-Seite zeigt den Bridge-Status und das MediaMTX-Ziel direkt an.

## Zeitraffer im Webserver

Fuer die Pi-Kamera und den DFR1154 gibt es auf `/camera` einen eigenen einklappbaren Bereich:

- listet JPEG- und MP4-Dateien aus dem Zeitrafferordner
- erzeugt auf Wunsch eine MP4 aus den vorhandenen JPEG-Bildern
- zeigt das neueste MP4 direkt im Browser an
- kann einzelne Dateien oder alle JPG/MP4-Dateien loeschen

Pi und DFR1154 speichern keine Zeitrafferbilder auf dem Kamerageraet. Der Server liest den bereits
vorhandenen MediaMTX-Stream in dem eingestellten Intervall mit FFmpeg und schreibt ein JPEG in den
jeweiligen Serverordner. Pro Kamera gilt ein eigenes GB-Limit. Zusaetzlich kann ein globales Limit
gesetzt werden und `CAMERA_TIMELAPSE_MIN_FREE_GB` verhindert, dass die Serverplatte vollgeschrieben wird.

Die Einstellungen `timelapse_enabled`, `timelapse_interval_seconds` und `timelapse_limit_gb` werden
ueber MQTT an die Kamera gesendet und dort als Soll-Konfiguration behalten. Der eigentliche
Aufnahmestatus wird unter `camera/<id>/status/server_capture/*` vom Server publiziert.
