(function () {
  const vitalsContainer = document.getElementById("home-vitals-container");
  if (!vitalsContainer) return;

  const numFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
  const currencyFormat = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });

  let refreshTimer = null;
  let inFlight = false;

  function number(value, fallback = "--") {
    const n = Number(value);
    return Number.isFinite(n) ? numFormat.format(n) : fallback;
  }

  function renderLoggedOut() {
    vitalsContainer.innerHTML = `
      <div class="helper-box home-login-hint">
        <p>Deine Live-Messwerte und Anlagen-Vitaldaten warten auf dich.</p>
        <a class="btn btn-secondary summary-login" href="/login">Jetzt anmelden <span aria-hidden="true">→</span></a>
      </div>
    `;
  }

  function renderVitals(data) {
    const { power, solar, hydro, system } = data;

    // 1. Power
    const powerOnline = Boolean(power?.online);
    const powerW = power?.powerW != null ? `${number(power.powerW)} <small>W</small>` : "-- <small>W</small>";
    const powerToday = power?.todayKwh != null ? `${number(power.todayKwh, 0)} kWh` : "-- kWh";
    const powerCost = power?.costTodayEur != null ? currencyFormat.format(power.costTodayEur) : "-- €";
    const powerTotal = power?.totalKwh != null ? `${number(power.totalKwh, 0)} kWh` : "--";

    // 2. Solar & Battery
    const solarOnline = Boolean(solar?.online);
    const solarW = solar?.solarW != null ? `${number(solar.solarW)} <small>W PV</small>` : "-- <small>W PV</small>";
    const solarYield = solar?.yieldTodayWh != null ? `${number(solar.yieldTodayWh)} Wh` : "-- Wh";
    const socPercent = solar?.batterySocPercent != null ? `${solar.batterySocPercent} %` : "-- %";
    const flowText = solar?.batteryFlow === "charging"
      ? `Lädt (${solar.batteryPowerW || 0} W)`
      : solar?.batteryFlow === "discharging"
        ? `Entlädt (${solar.batteryPowerW || 0} W)`
        : "Standby";

    // 3. Hydroponic
    const hydroObj = hydro?.activeObjectName || "Kein Objekt";
    const latest = hydro?.latestReading;
    let hydroPrimary = "--";
    if (latest && latest.value != null) {
      hydroPrimary = `${latest.value} <small>${latest.unit || ""}</small>`;
    } else if (hydro?.totalObjects > 0) {
      hydroPrimary = "Bereit";
    }
    const hydroRules = hydro?.activeRules != null ? `${hydro.activeRules} aktiv` : "--";

    // 4. Cameras & Host
    const camOnline = system?.camerasOnline ?? 0;
    const camTotal = system?.camerasTotal ?? 0;
    const ramPct = system?.ramPercent != null ? `${system.ramPercent} %` : "-- %";
    const mqttClients = system?.mqttClients != null ? `${system.mqttClients} Clients` : "--";

    vitalsContainer.innerHTML = `
      <div class="home-vitals-grid">
        <!-- 1. Stromnetz -->
        <article class="vitals-card vitals-card-energy">
          <div class="vitals-card-header">
            <span class="vitals-card-title"><span class="vitals-icon" aria-hidden="true">⚡</span> Stromnetz</span>
            <span class="status-badge ${powerOnline ? 'status-online' : 'status-offline'}">${powerOnline ? 'LIVE' : 'OFFLINE'}</span>
          </div>
          <div class="vitals-primary">${powerW}</div>
          <div class="vitals-details">
            <p><span>Heute:</span> <strong>${powerToday}</strong> <small>(${powerCost})</small></p>
            <p><span>Zählerstand:</span> <span>${powerTotal}</span></p>
          </div>
          <a class="vitals-action" href="/energy">Zum Strom-Tab <span aria-hidden="true">→</span></a>
        </article>

        <!-- 2. Solar & Akku -->
        <article class="vitals-card vitals-card-solar">
          <div class="vitals-card-header">
            <span class="vitals-card-title"><span class="vitals-icon" aria-hidden="true">☀️</span> Solar &amp; Akku</span>
            <span class="status-badge ${solarOnline ? 'status-online' : 'status-offline'}">${solarOnline ? 'LIVE' : 'OFFLINE'}</span>
          </div>
          <div class="vitals-primary">${solarW}</div>
          <div class="vitals-details">
            <p><span>Akku-SoC:</span> <strong>${socPercent}</strong> <small>(${flowText})</small></p>
            <p><span>Ertrag heute:</span> <span>${solarYield}</span></p>
          </div>
          <a class="vitals-action" href="/energy">Solar-Details <span aria-hidden="true">→</span></a>
        </article>

        <!-- 3. Hydroponik -->
        <article class="vitals-card vitals-card-hydro">
          <div class="vitals-card-header">
            <span class="vitals-card-title"><span class="vitals-icon" aria-hidden="true">♧</span> Hydroponik</span>
            <span class="status-badge ${hydro?.totalObjects > 0 ? 'status-online' : 'status-offline'}">${hydro?.totalObjects > 0 ? 'AKTIV' : 'LEER'}</span>
          </div>
          <div class="vitals-primary">${hydroPrimary}</div>
          <div class="vitals-details">
            <p><span>Objekt:</span> <strong title="${hydroObj}">${hydroObj}</strong></p>
            <p><span>Automationen:</span> <span>${hydroRules}</span></p>
          </div>
          <a class="vitals-action" href="/hydroponic">Zur Steuerung <span aria-hidden="true">→</span></a>
        </article>

        <!-- 4. Kameras & Host -->
        <article class="vitals-card vitals-card-system">
          <div class="vitals-card-header">
            <span class="vitals-card-title"><span class="vitals-icon" aria-hidden="true">◉</span> Kameras &amp; Server</span>
            <span class="status-badge status-online">ONLINE</span>
          </div>
          <div class="vitals-primary">${camOnline} / ${camTotal} <small>Kameras</small></div>
          <div class="vitals-details">
            <p><span>RAM-Auslastung:</span> <strong>${ramPct}</strong></p>
            <p><span>MQTT-Verbindungen:</span> <span>${mqttClients}</span></p>
          </div>
          <a class="vitals-action" href="/camera">Kamera-Leitstand <span aria-hidden="true">→</span></a>
        </article>
      </div>
    `;

    // Micro-Badges in the workspace cards below
    updateWorkspaceBadges(data);
  }

  function updateWorkspaceBadges(data) {
    const elDash = document.getElementById("badge-dash");
    if (elDash && data.system) {
      elDash.textContent = `● ${data.system.mqttClients} Clients online • RAM ${data.system.ramPercent}%`;
    }
    const elCam = document.getElementById("badge-cam");
    if (elCam && data.system) {
      elCam.textContent = `● ${data.system.camerasOnline}/${data.system.camerasTotal} Kameras online`;
    }
    const elEnergy = document.getElementById("badge-energy");
    if (elEnergy && data.power) {
      const pW = data.power.powerW != null ? `${data.power.powerW} W Netz` : "";
      const sW = data.solar?.solarW != null ? `${data.solar.solarW} W PV` : "";
      const sep = pW && sW ? " • " : "";
      elEnergy.textContent = `● ${pW}${sep}${sW || "Bereit"}`;
    }
    const elHydro = document.getElementById("badge-hydro");
    if (elHydro && data.hydro) {
      elHydro.textContent = `● ${data.hydro.activeObjectName || "Kein Objekt"} (${data.hydro.activeRules} Regeln)`;
    }
  }

  async function fetchHomeOverview() {
    if (document.hidden || inFlight) return;
    inFlight = true;

    try {
      const res = await fetch("/api/home/overview", {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Fehler");

      if (data.loggedIn === false) {
        renderLoggedOut();
      } else {
        renderVitals(data);
      }
    } catch (err) {
      if (!vitalsContainer.querySelector(".vitals-card")) {
        vitalsContainer.innerHTML = `
          <div class="error-msg" role="status">
            Live-Vitalwerte konnten nicht geladen werden (${err.message}).
            <button class="btn btn-secondary" type="button" id="vitals-retry">Erneut versuchen</button>
          </div>
        `;
        document.getElementById("vitals-retry")?.addEventListener("click", fetchHomeOverview);
      }
    } finally {
      inFlight = false;
    }
  }

  fetchHomeOverview();
  refreshTimer = setInterval(fetchHomeOverview, 5000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) fetchHomeOverview();
  });
})();
