# Kamera Streaming mit MediaMTX

## Zielaufbau

- Raspberry Pi erzeugt den Videostream und published ihn zu MediaMTX.
- MediaMTX laeuft parallel zum Node-Webserver auf demselben Server.
- Der Node-Webserver stellt die `/camera`-Seite, MQTT-Steuerung und Statusdaten bereit.
- Browser lesen den Stream ueber MediaMTX, bevorzugt per WebRTC.

## Rollen

- Node-Webserver:
  - `/camera` Seite
  - `/api/camera/*` Endpunkte
  - MQTT Publish fuer Start, Stop, Restart und Parameter
  - Statusanzeige aus MQTT Topics
- MediaMTX:
  - Stream-Annahme
  - Ausgabe als WebRTC, HLS und RTSP
- Raspberry Pi:
  - `rpicam-vid`
  - Publish per FFmpeg an MediaMTX

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

## Beispiel MediaMTX

Siehe [mediamtx.camera.example.yml](C:/Users/paulw/OneDrive/Desktop/NodejsWebServer/NodeJsWebServer/docs/mediamtx.camera.example.yml).
