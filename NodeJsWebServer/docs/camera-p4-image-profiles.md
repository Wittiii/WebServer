# ESP32-P4: Bildprofile testen

## Testprofile im Node-Webserver

Die P4-Kameraseite bietet **Testprofil** und **Profil anwenden**. Die Profile
stehen in `src/config/cameraImageProfiles.js` des Node-Projekts. Jede Auswahl
sendet einen vollstaendigen Bildauftrag als QoS1 ohne Retain. Die normale
korrelierte Kameraquittung entscheidet ueber Erfolg. Die Auswahl allein sendet
nichts; das gilt auch bei eingeschalteter Live-Uebernahme.

| ID | Profil | Besonderheit gegenueber Neutral |
| --- | --- | --- |
| neutral | Neutral | gamma72, Schaerfe45, Denoise5, AE70, Kontrast128, Saettigung120 |
| detail | Details | Denoise3, Schaerfe50 |
| quiet | Ruhig | Denoise7, Schaerfe32, Kontrast124, Saettigung116 |
| low-light | Wenig Licht | gamma64, AE78, Helligkeit2, Kontrast120, Saettigung112, Schaerfe32, Denoise6 |
| highlights | Helle Lichtquellen | AE55, gamma68, Kontrast120, Saettigung116, Schaerfe40 |
| reference | OV5647 Referenz | AE80, Saettigung128; gleiche neue Firmware-Farbmatrix |
| indoor-fixed | Innenlicht fest | AWB aus, Rot1.15x, Blau3.40x; Versuch fuer aktuelles Innenlicht |

Alle Profile setzen `preset=0`, `hue=0`, `adaptive_image=true` und
`gain_limit=15500`. Ausser Innenlicht fest verwenden sie AWB. Manuelle
WB-Sollwerte werden beim Rueckwechsel auf 1000 zurueckgesetzt. Aufloesung,
FPS, GOP, Bitrate, Montage und Capture werden nicht mitgesendet.

HTTP ueber den vorhandenen authentifizierten/CSRF-geschuetzten Endpunkt:

```json
{"cameraId":"esp32-p4-cam-01","action":"image_profile","profileId":"neutral"}
```

`GET /api/camera/overview` enthaelt je Kamera `imageProfiles`; nur P4 bekommt
Profile. `available=false` bedeutet, dass die gemeldeten Firmware-Regler
nicht alle Profilwerte erlauben. Unbekannte IDs und zusaetzliche Overrides
werden abgelehnt. Zur Kamera geht weiter das unveraenderte `cmd/set`-Topic.

## Farbmatrix-Revision ov5647-ccm-gain-v1

Die bestehenden temperaturabhaengigen OV5647-Matrizen bleiben die Basis.
ACC-Modell1 verfolgt die Farbtemperatur mit 100-K-Schritten. Die neue
CCM-Gain-Kennlinie mischt die Matrix mit der Einheitsmatrix:
`M_eff = (1-s) * I + s * M_CT`. Bei Gain1..2 ist s=1.0, bei4 s=0.95,
bei8 s=0.85 und bei15.5 s=0.70; dazwischen wird interpoliert. Dadurch sinkt
bei hohem Gain die Verstaerkung von Farbdifferenzen. Die neutrale RGB-Achse
bleibt erhalten. Das ist keine vermessene neue Sensor-Farbkalibrierung.

Der OV5647-Treiber liefert keine generischen Gain-Statistiken. Ein kleiner
C++-Adapter gibt deshalb den bereits aus Sensorregistern gelesenen,
geglaetteten Gain an `esp_ipa_pipeline_process` weiter. Die restlichen
Statistiken und Sensorwerte werden unveraendert weitergegeben. Laufzeit-Updates
der IPA fuer Gamma, Kontrast, Saettigung, Farbton, Helligkeit, Bayer-Filter und
Nachschaerfung werden dabei unterdrueckt: Diese Regler gehoeren der Anwendung,
damit IPA-Standardwerte ein ausgewaehltes Testprofil nicht ueberschreiben.
Initialisierungswerte sowie automatische CCM/LSC bleiben erhalten.
Bei ausgeschaltetem AWB werden auch interne AWB-/Rot-/Blau-Updates
unterdrueckt. Die 500-ms-Kontrolle vergleicht die tatsaechlichen manuellen
WB-Gains und korrigiert einen noch nachgelaufenen alten Automatik-Schreibzugriff.
Beim Rueckwechsel auf AWB werden dessen Updates wieder freigegeben. Ohne frische
Messung fuer 2 s greift wieder der native Wert. Vendorteile bleiben unveraendert.

`status/config.color_tuning_revision` kennzeichnet den Stand. Unter
`status/sensor` stehen `ipa_gain`, `ipa_gain_measured`, `ccm_valid`,
`ccm_enabled` und die neun zeilenweise angeordneten Werte in `ccm_matrix`.
Die CCM-Kennlinie gilt unabhaengig vom Schalter fuer Rauschfilter/Nachschaerfung.

`config/ov5647_ipa.json` ist die editierbare Quelle. `tools/update_ipa.py`
validiert und erzeugt `src/camera/Ov5647IpaConfig.c`; CMake fuehrt dies beim
Konfigurieren automatisch aus. `python tools/update_ipa.py --check` prueft,
ob JSON und kompilierte Quelle uebereinstimmen.


## Verwendung

1. Den aktualisierten Webserver-Code auf den laufenden Server uebernehmen und
   den vorhandenen Node-Dienst neu starten. Die Zugangsdaten und die Datenbank
   bleiben in ihren vorhandenen Dateien.
2. Kameraseite neu laden und **ESP32-P4** auswaehlen.
3. Bei **Testprofil** mit **Neutral** beginnen und **Profil anwenden** klicken.
4. Auf die Kamera-Bestaetigung und das nachlaufende HLS-Bild warten. Danach
   dieselben statischen Details, dunklen Flaechen und hellen Stellen vergleichen.
5. **Details** gegen **Ruhig** testen. **Innenlicht fest** ist ein gezielter
   Weissabgleich-Versuch fuer das aktuelle Licht, kein universelles Tageslichtprofil.

Alle Zahlen sind Startpunkte fuer Vergleichstests. Sie sind weder an einer
Farbtafel vermessen noch als identische Pi-Bildqualitaet bestaetigt.
Vor dem Vergleich eigene bevorzugte Werte notieren; Profilanwenden ersetzt
alle im Profil enthaltenen Bildregler. Einzelne Regler bleiben danach bedienbar.

Geaenderte Server-Dateien:

- `src/config/cameraImageProfiles.js` (neu)
- `src/config/cameraConfig.js`
- `src/controllers/cameraController.js`
- `public/pages/camera/camera.html`
- `public/pages/camera/camera.js`
- `public/pages/style.css`

Die neuen Profile verwenden die vorhandenen Kamera-Topics. Sie funktionieren
auch mit vorheriger Firmware, sofern diese alle benoetigten Regler meldet;
die neue Farbmatrix benoetigt den aktualisierten Firmware-Build.


## Verifizierter Abschluss am 30.10.2026

Firmware erfolgreich gebaut und ueber COM3 installiert, Flash-Hashes geprueft.
Aktuelles App-Image: 1502016 Bytes, SHA256 `beac260d25d41106d977d822c6ef9d99f88de0ad8837108bc5641cf5c422a186`.
Die Kamera meldet `ov5647-ccm-gain-v1`; bei 15.5x gemessenem Gain wurde die
70-Prozent-Mischung der CCM am laufenden ISP nachgerechnet und bestaetigt.

Neutral und Innenlicht fest wurden per korreliertem MQTT-Auftrag am P4
angewendet und als RTSP-Einzelbilder dekodiert. Der feste Weissabgleich
wurde mit tatsaechlich ausgelesenen Rot1.15x/Blau3.40x bestaetigt. Die
zuvor moegliche Ueberschreibung durch interne AWB-Updates ist abgesichert.
Anschliessend wurden die zuvor vom Nutzer eingestellten Bildwerte wiederhergestellt.
Stream- und Montagewerte sowie Capture wurden beim Profiltest nicht veraendert.

17 Kameratests bestehen mit den finalen Profilwerten. Der vollstaendige
Webserver-Testlauf bestand mit 138 Tests und einem unter Windows
uebersprungenen Symlink-Test. Native Gain-Adapter-Tests und zwei
CCM-Konfigurationstests bestanden ebenfalls.

Ein Remote-Deployment des Node-Webservers wurde in dieser Sitzung nicht
vorgenommen. Fuer die Profilauswahl muss dessen laufender Prozess den
aktualisierten lokalen Quellstand verwenden; anschliessend die Kameraseite
neu laden. Die Testprofile sind Ausgangspunkte, keine Farbchart-Kalibrierung.
