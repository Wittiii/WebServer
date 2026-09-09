# NodeJsWebServer

Express-Anwendung mit eingebettetem MQTT-Broker, SQLite-Messwerten,
Automatisierungen sowie Kamera-/Timelapse-Verwaltung. Zielsystem ist ein
Raspberry Pi 4; der HTTP-Startbefehl bleibt `node src/app.js` bzw. `npm start`.

## Installation und lokale Daten

Im Verzeichnis dieser `package.json` arbeiten. Node.js muss zu `engines` in
`package.json` und zum nativen Paket `better-sqlite3` passen. Die Tests wurden
lokal mit Node.js 24.11.1 unter Windows ausgeführt. FFmpeg und MediaMTX werden
für die Kamerafunktionen separat benötigt; siehe [Kamera-Dokumentation](docs/camera-streaming.md).

```bash
npm ci --omit=dev
```

Nur bei einer **Neuinstallation** `src/config/.env.example` als
`src/config/.env` kopieren und Zugangsdaten eintragen. Eine vorhandene `.env`
beibehalten. `SESSION_SECRET`, `ADMIN_USER`, `ADMIN_PASS`, `MQTT_USER` und
`MQTT_PASS` konfigurieren; die Platzhalter sind keine geeigneten Zugangsdaten.

- Datenbank: standardmäßig `src/database/app.db`; `DATABASE_PATH` überschreibt
  den Pfad. Ein relativer Wert bezieht sich auf das Arbeitsverzeichnis.
- Konfiguration: `src/config/.env`; optional ein anderer Pfad via `ENV_FILE`.
- Kameraarchive: `data/timelapse/` oder die konfigurierten Archivpfade.
- Datenbank, `.env`, Archive, Logs und installierte `node_modules` bleiben lokal.
  Die Entfernung von `node_modules` aus dem Git-Index löscht keine lokal
  installierten Pakete während der Entwicklung. Beim ersten Update auf diesen
  Stand muss der Pi seine Pakete anschließend mit `npm ci --omit=dev` installieren.

## Sicherung und Update auf dem Pi

Sicherung mit der SQLite-Backup-API, einschließlich bereits geschriebener
WAL-Daten, ohne Migrationen an der Quelle auszuführen:

```bash
npm run backup -- "$HOME/server-backups"
```

Jeder Aufruf erstellt einen neuen Unterordner. Die Datenbank wird geprüft und
die vorhandene `.env` mitgesichert. Nur bei erfolgreichem Exit ist die Sicherung
vollständig. Archive sind nicht Teil dieser Sicherung. Sie kann online laufen;
für ein konsistentes Update trotzdem zuerst den Server mit dem tatsächlich
verwendeten Dienstmanager stoppen und den Prozessende abwarten. Der Backup-Befehl
ist erst verfügbar, nachdem dieser neue Code auf dem Pi vorhanden ist.

Für den ersten Wechsel von einem älteren Stand: vor dem Pull eine geprüfte
SQLite-Sicherung und eine Kopie der `.env` außerhalb des Repos anlegen. Bei
WAL nicht nur die laufende `app.db` mit `cp` kopieren und keine `-wal`-Datei
weglegen oder löschen. Nach sauberem Stop kann alternativ die gesamte
Dateigruppe `app.db`, `app.db-wal`, `app.db-shm` zusammen gesichert werden.

Nach veröffentlichtem Update, bei gestopptem Server und geprüftem `git status`:

```bash
git pull --ff-only
npm ci --omit=dev
npm test
```

Jeder Schritt muss erfolgreich sein, bevor der nächste ausgeführt wird. Falls
Git lokale Änderungen meldet, diese zuerst prüfen; Datenbank, Konfiguration und
eigene Codeänderungen nicht mit `git restore`, Reset oder einem pauschalen Stash
verwerfen. Besonders der erste Pull kann wegen bisher verfolgter, auf dem Pi
veränderter `node_modules` blockieren. Erst danach den Server wieder starten.
Kein zweites `npm start` neben einem bereits laufenden systemd-/PM2-Dienst starten.

## Aufbau und Erweiterungen

| Bereich | Aufgabe |
| --- | --- |
| `src/app.js` | HTTP-Konfiguration und Routen; `createApp()` |
| `src/server.js` | Start/Stop von HTTP, MQTT, Jobs und Datenbank |
| `src/mqttBroker.js` | Broker, Geräte-/Topic-Status und Messwertverteilung |
| `src/controllers/`, `src/routes/` | HTTP-Ein-/Ausgabe, Authentifizierung und Eingabeprüfung |
| `src/services/` | Automatisierung, Messwerte, Archive und Medienprozesse |
| `src/database/db.js` | SQLite-Schema und bestehende Migrationen |
| `public/pages/` | Browseroberfläche |
| `test/` | Isolierte Regressionstests; keine produktive Datenbank/Kamera |

Neue Geräteverarbeitung als Service ergänzen und im MQTT-Verteiler aufrufen.
HTTP-APIs durch `apiAuth` schützen, Seitennavigation durch `authGuard`. Neue Jobs
brauchen eine Stop-Funktion und müssen vor dem Schließen der Datenbank beendet
werden. Lange Medienprozesse verwenden `mediaProcessService`; Abfragen und
Rückgaben begrenzen. Keine globale DB-Transaktion um mehrere Ingest-Services
legen, solange deren Sampling-Zustand nicht erst nach dem äußeren Commit
aktualisiert wird.

## Ressourcen und Sicherheitsänderungen

- MQTT-WebSockets verwenden einen richtigen Duplex-Stream. Pakete werden vor dem
  vollständigen Einlesen auf 128 KiB begrenzt; Publish-Payloads auf 64 KiB und
  Topics auf 1.024 Bytes. Maximal 128 aktive Broker-Verbindungen. Topic-Vorschauen
  im Webserver belegen höchstens 8 MiB bzw. 2.000 Einträge; sie sind kein Archiv.
- MQTT-Lese-APIs verlangen jetzt ebenfalls eine Anmeldung. Login rotiert die
  Session-ID; fehlende Admin-Konfiguration wird abgewiesen. Zehn fehlgeschlagene
  Logins pro IP innerhalb von 15 Minuten führen vorübergehend zu HTTP 429.
- Sessions sind begrenzt und laufen ab; wie bisher ist nach einem Neustart eine
  erneute Anmeldung nötig. Browser-Schreibzugriffe müssen dieselbe Origin haben.
  Bei einem HTTPS-Reverse-Proxy nur dessen bekannte IP/Subnetze in `TRUST_PROXY`
  eintragen und Host/Protokoll korrekt weiterreichen. Ohne Proxy leer lassen.
- FFmpeg verwendet standardmäßig einen Encoder-Thread pro Prozess. Überschreiben
  über `ESP32_TRANSCODE_THREADS` bzw. `TIMELAPSE_FFMPEG_THREADS` (1–8). Es läuft
  höchstens ein Video-Build und eine Einzelbildaufnahme gleichzeitig; die
  Live-Bridges sind eigene Prozesse. Der Video-Build endet spätestens nach
  `TIMELAPSE_BUILD_TIMEOUT_MS` (Standard 30 Minuten).
- Fehlende Capture-Statuswerte verwenden jetzt das konfigurierte Intervall
  (Standard 60 Sekunden). Ein stehender Stream wird auch dann erkannt, wenn
  FFmpeg weiter unveränderte Fortschrittsmeldungen sendet.
- Archivlisten werden gemeinsam gecacht (Standard 5 Minuten); neue Serverbilder
  erscheinen sofort. Externe Dateiänderungen erscheinen spätestens beim nächsten
  Scan. API/Browser nutzen Seiten mit 200 Dateien (maximal 500 pro Anfrage).
- Sensorzahlen werden streng geprüft. Die bestehende Aufbewahrungsdauer bleibt
  unverändert; alte Rohdaten werden schrittweise in 500er-Paketen entfernt.
  Victron-Tagesaggregate bleiben für den Gesamtertrag dauerhaft erhalten.
- Konsolenstreams berücksichtigen langsame Verbindungen und sind auf zehn
  gleichzeitige Streams begrenzt. Normale Konsolenausgaben bleiben aktiv.
- `uuid` ist auf die reparierte CommonJS-kompatible Version 11 begrenzt, damit
  Aedes 0.51 ohne einen ESM-Majorwechsel weiterläuft ([Sicherheitshinweis des Herstellers](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq)). TCP-/WS-Protokolltests
  prüfen diese Kombination. `npm audit --omit=dev` prüft den aktuellen Lockstand.

HTTP und MQTT-TCP/WS stellen selbst kein TLS bereit; die Anwendung für den
vertrauenswürdigen LAN-Zugriff bzw. einen passend abgesicherten Zugang betreiben.
Der eingebettete Broker ist ein einzelner Prozess mit In-Memory-MQTT-Persistenz,
kein dauerhaftes MQTT-Nachrichtenarchiv.

## Diagnose und Grenzen der Prüfung

```bash
curl --fail http://127.0.0.1:5000/healthz
df -h /
free -h
ps -eo pid,pcpu,pmem,rss,etime,comm --sort=-pcpu | head -15
```

Den Port an `PORT` anpassen. `/healthz` prüft HTTP-Erreichbarkeit, keine externen
Kameras. Nach Anmeldung liefert `/api/system/status` Speicherverbrauch und
Event-Loop-Verzögerung. Die Konsole protokolliert Pausen über 500 ms mit
`[Runtime]`, höchstens einmal pro Minute. `SIGTERM`/`SIGINT` stoppt Jobs und
Verbindungen, bevor SQLite geschlossen wird.

SQLite bleibt standardmäßig bei `DELETE/FULL`; es gibt keinen Nachweis, dass
WAL die früheren Pi-Hänger verursacht hat. Synchrone Schreibzugriffe und große
Verlaufsabfragen können auf einer langsamen SD-Karte weiterhin verzögern. Ein
manuell ausgelöstes `VACUUM` blockiert den Node-Prozess und gehört in ein
Wartungsfenster. Die bisherigen Datenbankindizes werden beim ersten Start eines
alten Schemas ebenfalls synchron angelegt. Last, Temperatur, Unterspannung,
freier Speicher und SD-/FFmpeg-Durchsatz müssen am tatsächlichen Pi geprüft
werden; lokale Tests sind kein Pi-Dauertest.
