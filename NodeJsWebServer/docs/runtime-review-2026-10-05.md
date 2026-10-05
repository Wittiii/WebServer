# Code- und Versionsprüfung für den Raspberry Pi 4 B

Stand: 05.10.2026. Geprüft wurden die Node-Anwendung, ihre Abhängigkeiten und
das MediaMTX-Konfigurationsbeispiel. Die tatsächlichen Versionen auf dem Pi
stammen aus den bereitgestellten Terminalausgaben. Auf dem Pi wurden keine
Dienste, Pakete oder Einstellungen geändert.

## Behobene Befunde

- Der Kamera-Supervisor fängt synchrone FFmpeg-Startfehler ab. RTSP-Werte mit
  Steuerzeichen werden verworfen, bevor sie als Prozessargument verwendet werden.
  Ein fehlerhafter Kamerastart beendet dadurch nicht mehr den Webserver.
- FFmpeg-Statusmeldungen sind auf 1.024 Zeichen begrenzt. Konsolenausgaben einer
  Bridge erfolgen höchstens alle fünf Sekunden und beim Prozessende. Der letzte
  Status wird weiter aktualisiert; unterdrückte Ausgaben werden gezählt.
- Automation lädt höchstens 32 Regeln mit ihren Aktionen pro Seite. Zwischen
  Seiten und nach ungefähr zehn Millisekunden Arbeit gibt sie die Ereignisschleife
  frei. Es bleibt dabei keine SQLite-Transaktion offen. Einzelne synchrone Abfragen
  können trotzdem länger dauern. Neue Regeln kommen beim nächsten Durchlauf hinzu.
- Abgebrochene Graphanfragen in der Warteschlange geben ihren Platz sofort frei.
- Gemeinsame MQTT-Schlüssel werden je Nachricht einmal extrahiert und serialisiert.
  Der zusätzliche Cache bleibt auf 128 Schlüssel und geschätzte 256 KiB begrenzt;
  die gespeicherten Messwerte bleiben gleich.
- Ein MQTT-Client mit dauerhaft blockierter Ausgabe wird nach 60 Sekunden ohne
  `drain` getrennt. Damit können die Veröffentlichungen des Brokers weiterlaufen,
  auch wenn dieser Client den MQTT-Keepalive mit dem Wert null deaktiviert hat.
  Gesunde Clients bleiben verbunden. Die Änderung ergänzt den Transport für
  Aedes 0.x und erfordert keine Migration des Brokers.
- Energy- und Hydroponik-Abfragen im Browser haben zwölf Sekunden Zeitlimit,
  einschließlich des Lesens der Antwort. Danach wird ihre Aktualisierungssperre
  freigegeben. Manuelle Abbrüche bei einem Auswahlwechsel bleiben wirksam.
- Das MediaMTX-Beispiel verwendet `hlsAlwaysRemux: false`. HLS wird dort erst für
  einen Zuschauer aufbereitet; die erste HLS-Wiedergabe kann länger starten.
  Das Beispiel ersetzt keine vorhandene Konfiguration auf dem Pi.

Diese Befunde erklären mögliche Anwendungshänger oder zusätzliche Last. Sie
belegen keinen Zusammenhang mit dem früher gemessenen Paketverlust oder einem
Ausfall von SSH beziehungsweise Raspberry Pi Connect.

## Versionen und Updates

Die npm-Registry wurde abgefragt; `npm audit --omit=dev` meldete vor den Updates
keine bekannten Sicherheitslücken. Ein erfolgreiches Audit bewertet die bekannte
Advisory-Datenbank, keine externe MediaMTX-/FFmpeg-Installation.

| Komponente | Vorher / auf dem Pi | Ergebnis |
| --- | --- | --- |
| Express | 5.1.0 | Repo auf 5.2.1 aktualisiert |
| express-session | 1.18.2 | Repo auf 1.19.0 aktualisiert |
| ws | 8.21.3 im Lockfile | Repo auf 8.22.0 aktualisiert |
| better-sqlite3 | 12.6.2 | Beibehalten; Registry bietet 12.11.1 in der 12er-Reihe und 13.0.3 als neuen Hauptstand |
| Aedes | 0.51.3 | Beibehalten; 1.2.0 erfordert eine Migration der Brokerinitialisierung und Persistenz |
| dotenv | 16.6.1 | Beibehalten; 18.0.5 ist ein neuer Hauptstand mit geändertem Parserverhalten |
| Node.js | Pi: 20.20.2 | Technische Kompatibilität beibehalten; Node 24 LTS als geplanter Wechsel empfohlen |
| FFmpeg | Pi: 8:5.1.9-0+deb12u1+rpt1 | Installierte und angebotene Version der lokalen apt-Paketlisten stimmen überein |
| MediaMTX | Pi: 1.19.2 | Aktueller Herstellerstand 1.21.1; getrenntes Update nach dem Beobachtungstag planen |

Das SQLite-Update wurde zunächst geprüft und anschließend zurückgestellt:
Die veröffentlichten Binärpakete von 12.11.1 enthalten keine Node-20-Version
(ABI 115) für Windows x64 oder Linux arm64. Die Installation würde auf diesen
Systemen einen lokalen Compiler benötigen. 12.6.2 stellt beide Binärpakete noch
bereit. Bei einem Wechsel auf Node 24 kann das SQLite-Update erneut geprüft
werden; nach dem Node-Wechsel müssen native Pakete neu installiert werden.

Die Node-20-Reihe ist laut [Node.js-Releases](https://nodejs.org/en/about/previous-releases)
nicht mehr regulär unterstützt. Bei Aedes 1.x ändern sich
[Initialisierung und Persistenz](https://github.com/moscajs/aedes/releases/tag/v1.0.0).
Die SQLite-Binärpakete sind in den
[12.11.1-Release-Dateien](https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.11.1)
und [12.6.2-Release-Dateien](https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.6.2)
sichtbar. Änderungen an dotenv stehen im
[Hersteller-Changelog](https://github.com/motdotla/dotenv/blob/master/CHANGELOG.md).
MediaMTX 1.21.1 enthält unter anderem HLS- und Streamingverbesserungen;
siehe [Release](https://github.com/bluenviron/mediamtx/releases/tag/v1.21.1).

Die apt-Ausgabe basiert auf den lokalen Paketlisten. Sie belegt nicht, wann diese
zuletzt aktualisiert wurden. Die separate MediaMTX-Konfiguration, der Dienststart
und die Kamera-Publisher außerhalb dieses Repos wurden nicht vollständig geprüft.

## Messungen und verbleibende Grenzen

Die vollständige Testsuite bestand unter Windows x64 sowohl mit Node 20.20.2
als auch mit Node 24.11.1: jeweils 113 erfolgreiche Tests, keine Fehler und ein
wegen fehlender Windows-Symlinkrechte übersprungener Test (114 insgesamt).
Die Node-20-Prüfung verwendete eine isolierte Quellkopie und das passende native
SQLite-Binärpaket. Ein vollständiger Start, Anmeldung, geschützte APIs und
Shutdown wurden mit einer temporären Datenbank geprüft. Die produktive Datenbank
und `.env` wurden nicht verwendet.

Neue Regressionstests simulieren hängende HTTP-Antwortkörper, einen echten
Aedes-Broker mit nicht lesendem Subscriber, FFmpeg-Startfehler und Fehlerfluten,
viele Automationsregeln sowie abgebrochene Graphwarteschlangen. Das abschließende
`npm audit --omit=dev` meldete null bekannte Sicherheitslücken. Diese Tests liefen
nicht auf dem Raspberry Pi und ersetzen dessen Last- und Dauerbetriebsprüfung nicht.

Nachtrag zur ersten Ausführung auf dem Pi: Der Browser-Recovery-Test verwendete
anfangs für alle Antworten ein künstliches Zeitlimit von 200 ms. Das konnte bei
parallel laufenden Tests auch den gesunden Folgeabruf abbrechen. Eine verzögerte
gesunde Antwort von 350 ms reproduzierte denselben Fehler. Der Test löst die
simulierte Deadline nun gezielt aus, sobald der Client den hängenden Antwortbody
liest; der gesunde Folgeabruf bleibt bewusst verzögert. Die tatsächliche
Zwölf-Sekunden-Deadline der Anwendung bleibt unverändert. Nach dieser Korrektur
bestanden beide vollständigen lokalen Testsuiten erneut mit den oben genannten
Ergebnissen.

Die synthetische Graphprüfung mit 250.000 Messwerten lief unter Windows x64 und
Node 24.11.1 in 67–87 ms; die längste Timerpause betrug 51–61 ms. Sie verwendet
ausschließlich eine Datenbank im RAM und erfasst keine SD-Karten- oder Kameralast.
Die Ergebnisse sind kein Pi-Benchmark und kein Nachweis einer Beschleunigung
durch die Paketupdates.

SQLite-Schreibzugriffe und die exakte Graphzählung bleiben synchron. Die bestehende
DELETE-/FULL-Konfiguration wurde beibehalten. Mehrere gleichzeitig laufende
Encoder können zusammen hohe CPU-Last erzeugen. Sehr große Kameraarchive halten
weiterhin vollständige Dateilisten im RAM. Session-, Laufzeitlog-, SSE- und
Diagnosebudgets waren im geprüften Code bereits begrenzt.

Der Beobachtungstag sollte vor einem Update auf dem Pi beendet und der
Diagnosebericht gesichert werden. Für ein anschließendes veröffentlichtes
Node-Projektupdate gelten die bestehenden Backup-/Stop-/Installationsschritte
im README. Ein Repo-Pull aktualisiert weder Node.js noch MediaMTX oder FFmpeg.
