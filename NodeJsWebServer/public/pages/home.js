(function () {
  const vitalsContainer = document.getElementById("home-vitals-container");
  const loginBanner = document.getElementById("home-login-banner");
  const authDeck = document.getElementById("dashboard-authenticated-deck");
  if (!vitalsContainer) return;

  const numFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
  const currencyFormat = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });

  let inFlight = false;

  function number(value, fallback = "--") {
    const n = Number(value);
    return Number.isFinite(n) ? numFormat.format(n) : fallback;
  }

  function setBadge(el, online, onlineText = "LIVE", offlineText = "WARTET") {
    if (!el) return;
    el.textContent = online ? onlineText : offlineText;
    el.classList.toggle("status-online", Boolean(online));
    el.classList.toggle("status-offline", !online);
  }

  function renderLoggedOut() {
    if (authDeck) authDeck.hidden = true;
    if (loginBanner) {
      loginBanner.hidden = false;
      loginBanner.innerHTML = `
        <div class="helper-box home-login-hint" style="margin-bottom: 1rem;">
          <p>Melde dich an, um deine Live-Messwerte, den Schnellzugriff sowie das Server- &amp; MQTT-Dashboard zu sehen.</p>
          <a class="btn btn-secondary summary-login" href="/login">Jetzt anmelden <span aria-hidden="true">→</span></a>
        </div>
      `;
    }
  }

  function renderVitals(data) {
    if (loginBanner) {
      loginBanner.hidden = true;
      loginBanner.innerHTML = "";
    }
    if (authDeck && authDeck.hidden) {
      authDeck.hidden = false;
    }
    if (!window.__iotAuthenticated) {
      window.__iotAuthenticated = true;
      window.dispatchEvent(new CustomEvent("iot:authenticated"));
    }

    const { power, solar, hydro, system } = data;

    // 1. Power
    const powerOnline = Boolean(power?.online);
    const powerW = power?.powerW != null ? `${number(power.powerW)} <small>W</small>` : "-- <small>W</small>";
    const powerToday = power?.todayKwh != null ? `${number(power.todayKwh)} kWh` : "-- kWh";
    const powerCost = power?.costTodayEur != null ? ` (${currencyFormat.format(power.costTodayEur)})` : "";
    const powerTotal = power?.totalKwh != null ? `${number(power.totalKwh)} kWh` : "-- kWh";

    setBadge(document.getElementById("home-power-badge"), powerOnline, "LIVE", "OFFLINE");
    const elPowerPrimary = document.getElementById("home-power-primary");
    if (elPowerPrimary) elPowerPrimary.innerHTML = powerW;
    const elPowerToday = document.getElementById("home-power-today");
    if (elPowerToday) elPowerToday.textContent = `${powerToday}${powerCost}`;
    const elPowerTotal = document.getElementById("home-power-total");
    if (elPowerTotal) elPowerTotal.textContent = powerTotal;

    // 2. Solar & Battery
    const solarOnline = Boolean(solar?.online);
    const solarW = solar?.solarW != null ? `${number(solar.solarW)} <small>W PV</small>` : "-- <small>W PV</small>";
    const solarYield = solar?.yieldTodayWh != null ? `${number(solar.yieldTodayWh)} Wh` : "-- Wh";
    const socPercent = solar?.batterySocPercent != null ? `${solar.batterySocPercent} %` : "-- %";
    const flowText = solar?.batteryFlow === "charging"
      ? ` · Lädt (${solar.batteryPowerW || 0} W)`
      : solar?.batteryFlow === "discharging"
        ? ` · Entlädt (${solar.batteryPowerW || 0} W)`
        : "";

    setBadge(document.getElementById("home-solar-badge"), solarOnline, "LIVE", "WARTET");
    const elSolarPrimary = document.getElementById("home-solar-primary");
    if (elSolarPrimary) elSolarPrimary.innerHTML = solarW;
    const elSolarSoc = document.getElementById("home-solar-soc");
    if (elSolarSoc) elSolarSoc.textContent = `${socPercent}${flowText}`;
    const elSolarYield = document.getElementById("home-solar-yield");
    if (elSolarYield) elSolarYield.textContent = solarYield;

    // 3. Hydroponic
    const hydroObj = hydro?.activeObjectName || "Kein Objekt";
    const latest = hydro?.latestReading;
    let hydroPrimary = "--";
    if (latest && latest.value != null) {
      hydroPrimary = `${latest.value} <small>${latest.unit || ""}</small>`;
    } else if (hydro?.totalObjects > 0) {
      hydroPrimary = "Bereit";
    }
    const hydroRules = hydro?.activeRules != null ? `${hydro.activeRules} Regeln aktiv` : "--";

    setBadge(document.getElementById("home-hydro-badge"), (hydro?.totalObjects || 0) > 0, "AKTIV", "BEREIT");
    const elHydroPrimary = document.getElementById("home-hydro-primary");
    if (elHydroPrimary) elHydroPrimary.innerHTML = hydroPrimary;
    const elHydroObj = document.getElementById("home-hydro-obj");
    if (elHydroObj) elHydroObj.textContent = hydroObj;
    const elHydroRules = document.getElementById("home-hydro-rules");
    if (elHydroRules) elHydroRules.textContent = hydroRules;

    // 4. Cameras & System
    const camOnline = system?.camerasOnline ?? 0;
    const camTotal = system?.camerasTotal ?? 0;
    const ramPct = system?.ramPercent != null ? `${system.ramPercent} %` : "-- %";
    const mqttClients = system?.mqttClients != null ? system.mqttClients : "--";

    setBadge(document.getElementById("home-cam-badge"), camOnline > 0 || camTotal > 0, "ONLINE", "BEREIT");
    const elCamPrimary = document.getElementById("home-cam-primary");
    if (elCamPrimary) elCamPrimary.innerHTML = `${camOnline} / ${camTotal} <small>Kameras</small>`;

    const elDash = document.getElementById("badge-dash");
    if (elDash && system) {
      elDash.textContent = `● ${mqttClients} MQTT-Clients verbunden · RAM ${ramPct}`;
    }

    const sysPill = document.getElementById("home-quick-system-pill");
    if (sysPill && system) {
      sysPill.textContent = `${mqttClients} Clients · RAM ${ramPct}`;
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
    } catch {
      // Keep existing cards interactive on transient network hiccups
    } finally {
      inFlight = false;
    }
  }

  fetchHomeOverview();
  setInterval(fetchHomeOverview, 5000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) fetchHomeOverview();
  });
})();
