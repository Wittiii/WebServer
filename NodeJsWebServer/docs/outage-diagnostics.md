# Ausfälle auf dem Raspberry Pi nachvollziehen

Beim nächsten Ausfall sollen die letzten Messungen nach der Wiederherstellung
weiter lesbar sein. Der Webserver startet dafür auf Linux einen eigenen
Diagnoseprozess vor dem Öffnen der Datenbank. Dieser prüft unabhängig von der
Node-Ereignisschleife alle 30 Sekunden den lokalen HTTP-Endpunkt `/healthz` mit
einem Zeitlimit von drei Sekunden und erfasst Systemwerte. Der Webserver sendet
zusätzlich alle fünf Sekunden seinen Laufzeitstatus über IPC. Bleibt seine
Ereignisschleife hängen, können die HTTP-Prüfung und das Alter dieses Heartbeats
im Diagnoseprozess weiterhin protokolliert werden.

Diese Funktion ist im Projekt implementiert. Erst nach Installation und Start
dieses Stands auf dem Pi entstehen dort Diagnoseprotokolle; ein lokaler Test
belegt noch keinen Dauerbetrieb auf dem Zielgerät. Ein Start aus einem Terminal
sichert außerdem keinen Neustart nach einem Prozessende. Dafür ist weiterhin
der tatsächlich verwendete Dienstmanager zuständig.

## Daten und Speicherort

Standardmäßig liegen die Dateien im Projekt unter `logs/diagnostics/`:

```text
diagnostics.jsonl
diagnostics.1.jsonl
diagnostics.2.jsonl
diagnostics.3.jsonl
```

Die aktuelle Datei rotiert vor Überschreiten von fünf MiB; die drei vorherigen
Dateien bleiben erhalten. Der maximale Dateibestand beträgt damit standardmäßig
ungefähr 20 MiB. Alte Einträge werden bei weiteren Rotationen verdrängt. Die
Dateien werden nach jedem Eintrag synchronisiert. Das reduziert das Risiko
verlorener Daten, garantiert bei Stromausfall, defektem Datenträger oder einem
Kernel-Hänger aber keine vollständige letzte Messung.

Für eine Beobachtung über zwei Tage kann optional
`DIAGNOSTICS_MAX_FILE_MB=10` gewählt werden: Die vier Dateien bieten dann
ungefähr 40 MiB statt 20 MiB. Bei der bislang beobachteten Datengröße schafft das
mehr Platz für etwa zwei Tage. Eine feste Aufbewahrungsdauer ist damit nicht
garantiert; sie hängt von Intervall und Größe der Messungen ab. Der Standard
bleibt bei fünf MiB je Datei. Dieser Hinweis ändert keine Pi-Konfiguration.

Jede JSON-Zeile enthält `timestamp` in UTC, `event` und eine `runId`. Erfasst werden
Start, Betriebsbereitschaft, geordnetes Stoppen, Diagnosefehler, Signale an den
Monitor, verworfene übergroße Einträge und der Abbruch der Verbindung zum
Webserverprozess. `sample` enthält die lokale HTTP-Prüfung, den
letzten Laufzeitstatus und dessen Alter sowie `system`:

Auf Linux enthält `system.bootId` außerdem die Boot-ID, sofern lesbar. Damit
können Messungen verschiedener Systemstarts unterschieden werden, auch wenn die
Anwendung innerhalb eines Boots mehrfach neu startet.

| Feld | Inhalt |
| --- | --- |
| `cpu`, `loadAverage`, `uptimeSeconds` | CPU-Auslastung, I/O-Warteanteil, Systemlast und Laufzeit |
| `memory`, `disk` | Verfügbarer RAM, Swap, freier Speicherplatz und Inodes |
| `thermal`, `throttling` | Temperaturzonen und Raspberry-Pi-Firmwareflags, sofern verfügbar |
| `pressure` | Linux-Wartezeiten für CPU, RAM und I/O, sofern unterstützt |
| `network` | Linkzustand, Geschwindigkeit/Duplex sowie Änderungen von Link-, CRC-, Carrierfehler- und Verwerfungszählern |
| `processes` | Begrenzte Prozessübersicht mit Name, PID, RAM und CPU; keine Kommandozeilen |
| `kernel` | Begrenzte relevante Kernelmeldungen; beim ersten Sample zusätzlich vorheriger Boot, soweit lesbar |
| `issues`, `unavailable` | Beobachtungen und Messquellen, die fehlen oder nicht zugänglich sind |

Der Monitor fragt vorhandene Systemdaten ab und führt begrenzte Diagnosebefehle
aus. Er ändert keine Netzwerkeinstellungen, startet keine Dienste neu und liest
keine Passwörter oder MQTT-Nutzdaten aus. Er läuft mit den Rechten des
Webserverbenutzers. Fehlende Werkzeuge oder fehlende Leserechte werden als
fehlende Messquelle erfasst; der Webserver soll deshalb weiter starten können.
Kernelmeldungen können Geräte- oder Netzwerkinformationen enthalten. Die
Diagnosedateien sollten deshalb gezielt weitergegeben werden.

## Konfiguration

Die bestehende `src/config/.env` beibehalten und bei Bedarf ergänzen:

```dotenv
DIAGNOSTICS_ENABLED=true
DIAGNOSTICS_INTERVAL_MS=30000
DIAGNOSTICS_MAX_FILE_MB=5
# Optional: absoluter Pfad oder relativ zum Arbeitsverzeichnis des Dienstes
# DIAGNOSTICS_DIR=/home/pi/server-diagnostics
```

Ohne Konfiguration ist die Aufzeichnung auf Linux aktiv und auf anderen
Betriebssystemen deaktiviert. `DIAGNOSTICS_ENABLED=false` schaltet sie aus.
Das Messintervall liegt zwischen 5.000 und 300.000 ms, die Dateigröße zwischen
einem und 20 MiB. Es bleiben immer vier Dateien. Der Standardpfad bezieht sich
auf das Projektverzeichnis; ein relativer eigener Pfad bezieht sich auf das
Arbeitsverzeichnis des Dienstes und sollte beim Bericht identisch aufgelöst
werden. Der Dienstbenutzer benötigt Schreibrechte auf diesem Verzeichnis.

## Nach Wiederherstellung auswerten

Im Projektverzeichnis zeigt der Textbericht zuerst die letzten gespeicherten
Auffälligkeiten pro Kategorie aus allen vorhandenen Dateien und danach die
letzten 20 gültigen Einträge. Dadurch bleibt ein protokollierter Ausfall auch
nach vielen unauffälligen Messungen sichtbar, solange seine Datei nicht durch
Rotation verdrängt wurde. Die Zusammenstellung behält höchstens zwölf
vollständige Einträge; ein Eintrag mit mehreren Beobachtungen erscheint darin
einmal. Wiederkehrende geringe PSI-Wartezeiten und ausschließlich historische
Firmwareflags verdrängen die Ausfallhinweise nicht.

```bash
node scripts/diagnostics-report.js
node scripts/diagnostics-report.js --tail 50
node scripts/diagnostics-report.js --tail 50 --details
node scripts/diagnostics-report.js --since 48h --tail 50 --details
node scripts/diagnostics-report.js --tail 50 --json
node scripts/diagnostics-report.js --dir /pfad/zu/diagnostics --tail 50
```

`--tail` akzeptiert eins bis 200 Einträge; `--json` liefert diese als vollständiges
JSON-Array der jüngsten Einträge; dieser CLI-Modus enthält keine zusätzliche
Auffälligkeitsliste. Der Bericht liest nur Diagnoseprotokolle und öffnet keine Datenbank.
Er lädt die bestehende `.env` ausschließlich als Konfiguration des
Diagnosepfads; `ENV_FILE` kann einen anderen Konfigurationspfad auswählen. Die
Konfiguration wird nicht ausgegeben. Fehlende Dateien sind erlaubt. Beschädigte
oder abgeschnittene Zeilen sowie Zeilen über 256 KiB werden übersprungen und im
Textbericht gezählt. Bei unlesbaren Dateien meldet der CLI einen Fehlerstatus.
Ein Lesen während einer Rotation ist keine atomare Momentaufnahme; bei einem
Verdacht auf verschobene Dateigrenzen den Bericht erneut abrufen.

Mit `node scripts/diagnostics-report.js --tail 50 --details` sind neben den
Signalwechseln auch die gespeicherten Kerneltexte und die Namen/Gründe fehlender
Messquellen lesbar. Die Detailausgabe zeigt höchstens zehn Kernelmeldungen je
Eintrag und 20 insgesamt mit jeweils maximal 500 Zeichen. Steuerzeichen werden
bereinigt; aktueller und vorheriger Boot sind gekennzeichnet. Ein Eintrag, der
sowohl unter Auffälligkeiten als auch im Tail erscheint, wird einmal erweitert.
Fehlende Quellen stehen dedupliziert am Ende, höchstens 20 mit ihrem jeweils
zuletzt beobachteten Grund aus den angezeigten Einträgen. `permission_denied`
bezeichnet fehlende Rechte, `not_available` eine fehlende/unerreichbare Quelle;
die bloße Anzahl sagt nicht, welche Quelle betroffen ist. Der normale
Textbericht bleibt kompakt. Bei `--json --details` bleibt die Ausgabe das
bisherige vollständige JSON-Array ohne zusätzliche Textblöcke. Der Schalter
zeigt ausschließlich bereits protokollierte Daten und führt keine neue Messung
auf dem Pi aus. Kerneltexte können Geräte- oder Netzwerkinformationen enthalten.

`--since 48h` (gleichwertig `--since 2d`) wertet alle gültigen Einträge innerhalb
der letzten 48 Stunden bis zur Uhrzeit des Rechners aus, auf dem der Bericht
läuft. Positive Angaben mit `h` oder `d` sind bis höchstens 30 Tage erlaubt.
Die Statistik berücksichtigt das gesamte gelesene Zeitfenster; `--tail` begrenzt
weiterhin nur die zusätzlich angezeigten jüngsten Einträge auf höchstens 200.
Der Reader behält höchstens zwölf Auffälligkeitsdatensätze, 200 Tail-Einträge und
begrenzte Statistiken statt aller Messungen im Speicher. Insgesamt werden
höchstens 80 MiB aus den vier Dateien gelesen; ein erreichtes Budget wird als
möglicherweise unvollständige Auswertung ausgewiesen. Die Grenze von 256 KiB je
Zeile gilt weiterhin. Die API behält ihre bisherige Tail-Grenze.
Ein erreichtes Lesebudget liefert den CLI-Fehlerstatus 1, auch wenn die
Dateigrenze zufällig genau mit dem Budget zusammenfällt.

Der Zeitfensterbericht nennt den gewünschten UTC-Beginn und das Ende, den
ältesten/neuesten tatsächlich gelesenen Eintrag sowie den ersten/letzten Eintrag
im Zeitfenster. Vier rotierte Dateien können weniger als 48 Stunden enthalten;
die fehlenden Stunden werden durch `--since` nicht wiederhergestellt. Größere
Zeitabstände zwischen Messungen sind Beobachtungen und kein Ausfallbeweis.
Summierte Verwerfungszähler liefern ohne Paketgesamtzahlen keine Verlustquote.
Für `node`, `nodejs`, `ffmpeg` und `mediamtx` enthält der Bericht zudem eine
begrenzte D-Prozessübersicht mit PID, Anzahl der Beobachtungen und Zeitfenster.
Dasselbe PID-Vorkommen in mehreren Prozesslisten wird je Messung einmal gezählt.
Erste und letzte Beobachtung messen keine durchgehende Wartezeit und belegen
keinen bestimmten Systemaufruf oder Datenbankfehler. Bei vorhandenen Daten zeigt
`--details` den bereinigten Wait-Channel mit höchstens 128 Zeichen; ältere
Protokolle enthalten dieses Feld möglicherweise nicht. Höchstens zehn Prozesse
werden für die Statistik behalten; bei mehr Prozessen meldet der Bericht die
möglicherweise unvollständigen Zähler.
Bei `--since ... --json` wird ein Objekt mit `range`, `summary`, `readBudget`,
begrenztem `records`-Tail und `notableRecords` ausgegeben. Ohne `--since` bleibt
`--json` das bisherige Tail-Array. Heruntergeladene Dateien können mit
`--dir /pfad/zur/lokalen/kopie` offline ausgewertet werden; der CLI ruft den Pi
nicht selbst ab und verändert dort nichts.

Nach Anmeldung ist dieselbe begrenzte Historie auch über
`GET /api/system/diagnostics?limit=20` abrufbar. Während der Webserver selbst
nicht antwortet, ist auch dieser Endpunkt nicht verfügbar. Die Dateien können
nach der Wiederherstellung ohne laufenden Webserver über den CLI gelesen werden.
Die API-Antwort enthält neben `records` auch `notableRecords` mit dieser begrenzten
Zusammenstellung aus der gesamten vorhandenen Historie.

## Befunde einordnen

- HTTP-Zeitüberschreitungen zusammen mit einem alten Heartbeat zeigen, dass der
  Webserver zuletzt keine zeitnahe Antwort oder Laufzeitmeldung geliefert hat.
  CPU-, RAM- und I/O-Werte helfen, diesen Zeitpunkt einzugrenzen.
- Ein lokaler erfolgreicher HTTP-Test bei gleichzeitigem Ausfall vom PC aus
  lenkt die weitere Prüfung auf die Verbindung zum Pi. Der Monitor testet weder
  den PC noch FRITZ!Box, Kabel, Internetzugang oder Raspberry Pi Connect von außen.
- Firmwareflags unterscheiden aktuelle Unterspannung/Drosselung von früheren
  Ereignissen seit dem Boot. Ein gesetztes historisches Flag datiert das Ereignis
  nicht und beweist keinen Zusammenhang mit dem Ausfall. Die Bedeutung der Bits
  dokumentiert [Raspberry Pi unter `get_throttled`](https://www.raspberrypi.com/documentation/computers/os.html#get_throttled).
- Erhöhte Netzfehlerzähler oder fehlendes Linksignal sind konkrete Beobachtungen;
  sie identifizieren allein noch kein bestimmtes defektes Kabel oder Gerät.
  Der Vergleich des Linkwechselzählers kann auch einen kurzen Abbruch zwischen
  den standardmäßig 30 Sekunden auseinanderliegenden Messungen erfassen, obwohl
  das Linksignal bei beiden Messungen wieder vorhanden ist. Änderungen der
  ausgehandelten Geschwindigkeit werden ebenfalls markiert. CRC- und
  Carrierfehlerzähler helfen bei der Prüfung des Ethernetpfads; erst ihre Änderung
  gegenüber der vorherigen Messung wird als neues Ereignis behandelt. Der erste
  bereits vorhandene Zählerstand datiert keine Störung.
- `parent_disconnect` bedeutet, dass die IPC-Verbindung beendet wurde. Es belegt
  keinen Absturzgrund. Der Diagnoseprozess protokolliert diesen Zustand nach
  Möglichkeit und beendet sich ebenfalls; er ist kein separat laufender Dienst.
- Bei vollständigem Systemstillstand, Stromverlust oder Ausfall des Monitors
  fehlen weitere Messungen. Eine Protokolllücke kann auch durch Rotation,
  Schreibfehler oder ausgeschaltete Diagnose entstehen. Keine dieser Situationen
  lässt sich allein aus der Lücke eindeutig unterscheiden.

## Kernelmeldungen über Neustarts erhalten

Zusätzlich kann ein persistentes systemd-Journal Kernelmeldungen des vorherigen
Boots erhalten. Bei der üblichen Einstellung `Storage=auto` aktiviert das
vorhandene Verzeichnis `/var/log/journal` die Speicherung auf dem Datenträger.
Die folgenden Befehle werden bei Bedarf direkt auf dem Pi ausgeführt:

```bash
sudo mkdir -p /var/log/journal
sudo systemd-tmpfiles --create --prefix /var/log/journal
sudo journalctl --flush
sudo journalctl --list-boots
```

Dies wird vom Projekt nicht automatisch ausgeführt. Bei explizitem
`Storage=volatile` oder `Storage=none` muss zuerst die bestehende
journald-Konfiguration geprüft werden; allein das Verzeichnis aktiviert dann
keine Persistenz. Die Verzeichnisbefehle und das Umschalten mit `--flush` sind in
der [offiziellen systemd-Dokumentation](https://github.com/systemd/systemd/blob/main/man/systemd-journald.service.xml)
beschrieben; die Speicheroptionen stehen in
[`journald.conf`](https://github.com/systemd/systemd/blob/main/man/journald.conf.xml).

Nach einem erneuten Boot helfen anschließend die begrenzten Ausgaben:

```bash
sudo journalctl -k -b -1 -n 100 --no-pager
sudo journalctl -k -b -n 100 --no-pager
```

Die automatische Erfassung kann diese Meldungen nur lesen, wenn der
Dienstbenutzer die erforderlichen Rechte besitzt. Das gesamte Programm deshalb
als root zu starten ist nicht erforderlich. Ein verfügbares Journal ist eine
zusätzliche Quelle; auch daraus folgt ohne passende Meldungen keine bewiesene
Ausfallursache.
