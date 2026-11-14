# Vertrauenswürdiges HTTPS auf dem Raspberry Pi 4 (ohne Browser-Warnung)

Standardmäßig erzeugt der Webserver ein selbstsigniertes Zertifikat (`data/tls/server.crt`). Die Verbindung ist damit zwar verschlüsselt, aber der Browser zeigt „Nicht sicher“, weil keine bekannte Zertifizierungsstelle (CA) unterschrieben hat.

Mit einer der beiden Methoden verschwindet die Warnung komplett (inkl. Mikrofon / Gegensprechanlage auf PC, Android & iPhone):

---

## Option 1: Tailscale (am einfachsten, auch für unterwegs ohne offene Router-Ports)

Tailscale erstellt kostenlos ein echtes **Let's Encrypt**-Zertifikat für deinen Pi4 (`https://<hostname>.<tailnet>.ts.net`). Jeder Browser vertraut diesem Zertifikat sofort ohne Import.

### 1. Auf dem Raspberry Pi 4
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```
Im Browser anmelden, danach in der Tailscale Admin-Konsole unter **DNS** einmalig **MagicDNS** und **HTTPS Certificates** aktivieren.

### 2. Zertifikat auf dem Pi4 erzeugen
Ersetze `<DEIN-TS-DOMAIN>` mit deinem Tailscale-Domainnamen (wird dir bei `tailscale status` angezeigt, z. B. `raspberrypi.tail1234.ts.net`):
```bash
sudo mkdir -p /etc/ssl/tailscale
sudo tailscale cert \
  --cert-file /etc/ssl/tailscale/server.crt \
  --key-file /etc/ssl/tailscale/server.key \
  <DEIN-TS-DOMAIN>
```
Leserechte für deinen Node.js-Benutzer (z. B. `pi`) setzen:
```bash
sudo chown -R $USER:$USER /etc/ssl/tailscale
```

### 3. In `src/config/.env` eintragen
```env
HTTPS_ENABLED=true
HTTPS_PORT=5443
HTTPS_CERT_PATH=/etc/ssl/tailscale/server.crt
HTTPS_KEY_PATH=/etc/ssl/tailscale/server.key
```
Server neu starten – danach ist das Dashboard unter `https://<DEIN-TS-DOMAIN>:5443` **im Heimnetz und unterwegs** mit echtem „Sicher“-Schloss erreichbar.

---

## Option 2: `mkcert` (nur Heimnetz, ohne Tailscale)

Mit `mkcert` erstellst du eine eigene lokale Root-CA auf dem Pi4 und installierst diese einmalig auf deinem PC/Handy.

### 1. `mkcert` auf dem Pi4 installieren & Zertifikat erzeugen
```bash
sudo apt update && sudo apt install -y libnss3-tools
curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/arm64"
chmod +x mkcert-v*-linux-arm64
sudo mv mkcert-v*-linux-arm64 /usr/local/bin/mkcert

mkcert -install
mkdir -p ~/NodejsWebServer/NodeJsWebServer/data/tls
mkcert \
  -cert-file ~/NodejsWebServer/NodeJsWebServer/data/tls/server.crt \
  -key-file ~/NodejsWebServer/NodeJsWebServer/data/tls/server.key \
  192.168.178.56 raspberrypi.local localhost 127.0.0.1
```
*(Ersetze `192.168.178.56` durch die echte LAN-IP deines Pi4.)*

### 2. Root-CA einmalig auf PC & Handy installieren
Den Pfad der Root-CA findest du auf dem Pi4 mit:
```bash
mkcert -CAROOT
```
Die Datei `rootCA.pem` (als `rootCA.crt` umbenennen) auf PC/Handy kopieren:
- **Windows:** Doppelklick auf `rootCA.crt` → *Zertifikat installieren* → *Lokaler Computer* → *Vertrauenswürdige Stammzertifizierungsstellen*.
- **Android:** *Einstellungen → Sicherheit → Verschlüsselung & Anmeldedaten → Zertifikat installieren → CA-Zertifikat*.
- **iPhone / iPad:** Datei per AirDrop/E-Mail öffnen → Profil installieren → *Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen* → Schalter für die `mkcert`-CA aktivieren.

Server neu starten – ab sofort zeigt der Browser bei `https://192.168.178.56:5443` ein **„Sicher“-Schloss** ohne Warnung.
