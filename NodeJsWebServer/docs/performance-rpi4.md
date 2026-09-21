# Performance auf dem Raspberry Pi 4 B

Prüfung vom 21.09.2026. Die Messungen stammen von Windows x64 mit Node
24.11.1 und einer synthetischen SQLite-Datenbank im Arbeitsspeicher. Sie sind
kein Pi-Benchmark und enthalten weder SD-Karten-Zugriffe noch Kameralast.

## Behobene Engpässe

- Graphen verwenden Zeitindizes und gezielte Stichproben statt einer vollständigen
  Sortierung der Historie. Bei 250.000 Messwerten sank die lokale Laufzeit von
  1.558–1.882 ms auf 79–110 ms im abschließenden Test. Zwischen Abfrageblöcken
  erhält der Server wieder Rechenzeit; dabei bleibt keine Lesetransaktion offen.
- Pro Datenbank läuft höchstens eine Graph-Abfrage, zwei weitere dürfen warten.
  Zusätzliche Anfragen erhalten HTTP 503 mit einem Wiederholungshinweis.
  Verbindungsabbrüche stoppen die Arbeit am nächsten Unterbrechungspunkt.
- Graph-Antworten enthalten keine wiederholten MQTT-Rohdaten. Textwerte über
  4.096 Zeichen werden ausgelassen und als `text_omitted` gekennzeichnet.
  Die Oberfläche erklärt dies; der Graph-CSV-Export übernimmt diese Kennzeichnung.
  Gespeicherte Originaldaten und der normale Messwert-Endpunkt bleiben erhalten.
- Der Laufzeit-Logpuffer hat zusätzlich zur Zeilengrenze ein Speicherbudget
  von 8 MiB nach Zeichen- und Metadatenschätzung. Das ist keine exakte Grenze
  für den gesamten V8-Heap oder vorübergehend beim Formatieren benötigten Speicher.
- Das Dashboard ermittelt die Größe der tatsächlich geöffneten Datenbank
  einschließlich einer vorhandenen WAL-Datei, auch bei eigenem `DATABASE_PATH`.

Beim ersten Serverstart werden zwei zusätzliche Messwertindizes aufgebaut.
Das kann bei großer Historie den Start verlängern und benötigt zusätzlichen
Plattenplatz. Bestehende Daten werden nicht gelöscht.

## Verbleibende Grenzen

- Die exakte Anzahl und Zeitspanne der Graph-Messwerte werden weiterhin synchron
  ermittelt. Im abschließenden Test betrug die längste Timerpause 57–67 ms.
  Sehr große Historien und zusätzliche Topic-Filter können mehr Zeit brauchen.
- Die Hydroponik-Messwerte haben keine automatische Aufbewahrungsfrist.
  Die Historie wächst dauerhaft; MQTT-Rohdaten werden je zugeordnetem Messwert
  gespeichert. Eine Löschfrist wurde bewusst nicht eingeführt.
- SQLite nutzt standardmäßig DELETE-Journal und FULL-Synchronisierung.
  Schreibtransaktionen werden je MQTT-Nachricht gebündelt, können bei hoher
  Messfrequenz aber durch den Datenträger begrenzt werden.
- FFmpeg ist standardmäßig auf einen Thread je Encoder begrenzt. Mehrere
  gleichzeitige Streams können zusammen trotzdem viel CPU verbrauchen.
  MP4-Aufbauten sind bereits serialisiert.
- MQTT-Nachrichtengrößen, Verbindungen, Topic-Puffer und Konsolenstreams sind
  bereits begrenzt. Diese Grenzen ersetzen keine Messung unter realer Last.

## Auf dem Pi nachmessen

Im Projektverzeichnis ausführen; vorzugsweise außerhalb der Hauptnutzung,
weil der Test selbst CPU und RAM benötigt:

```bash
npm run perf:check -- 250000
```

Der Test erstellt ausschließlich synthetische Daten im Arbeitsspeicher und
öffnet weder die produktive Datenbank noch die `.env`. Er meldet drei
Graph-Laufzeiten, Timerpausen und Antwortgrößen. Ohne Argument werden 100.000
Messwerte verwendet; erlaubt sind 10.000 bis 500.000.

Für die reale Last zusätzlich RAM, CPU und Ereignisschleifen-Verzögerungen
über den angemeldeten Endpunkt `/api/system/status` beobachten, während die
üblichen MQTT-Sensoren und Kameras laufen. Das Dashboard zeigt den Speicherbedarf
der Datenbank. Datenträger, Kühlung und gleichzeitig aktive Encoder beeinflussen
die Ergebnisse zusätzlich.
