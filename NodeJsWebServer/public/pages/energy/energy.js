const elements = {
  livePower: document.getElementById("energy-live-power"),
  onlineBadge: document.getElementById("energy-online-badge"),
  lastUpdate: document.getElementById("energy-last-update"),
  today: document.getElementById("energy-today"),
  costToday: document.getElementById("energy-cost-today"),
  dial: document.getElementById("energy-dial"),
  power: document.getElementById("energy-power"),
  voltage: document.getElementById("energy-voltage"),
  current: document.getElementById("energy-current"),
  factor: document.getElementById("energy-factor"),
  priceHint: document.getElementById("energy-price-hint"),
  balanceToday: document.getElementById("energy-balance-today"),
  balanceTodayCost: document.getElementById("energy-balance-today-cost"),
  yesterday: document.getElementById("energy-yesterday"),
  yesterdayCost: document.getElementById("energy-yesterday-cost"),
  total: document.getElementById("energy-total"),
  totalSince: document.getElementById("energy-total-since"),
  peak: document.getElementById("energy-peak"),
  average: document.getElementById("energy-average"),
  apparent: document.getElementById("energy-apparent"),
  reactive: document.getElementById("energy-reactive"),
  voltageRange: document.getElementById("energy-voltage-range"),
  samples: document.getElementById("energy-samples"),
  topic: document.getElementById("energy-topic"),
  startTime: document.getElementById("energy-start-time"),
  sourceTime: document.getElementById("energy-source-time"),
  sourceStatus: document.getElementById("energy-source-status"),
  chart: document.getElementById("energy-power-chart"),
  chartEmpty: document.getElementById("energy-chart-empty"),
  error: document.getElementById("energy-error"),
};

let selectedPeriod = "24h";
let latestHistory = [];

const numberFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
const currencyFormat = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });

function number(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  return numeric.toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function dateTime(value) {
  if (!value) return "--";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString("de-DE");
}

function setText(element, value) {
  if (element) element.textContent = value;
}

function formatAxisTime(timestamp) {
  const date = new Date(timestamp);
  if (selectedPeriod === "1h" || selectedPeriod === "24h") {
    return date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
}

function drawChart() {
  const canvas = elements.chart;
  if (!canvas) return;
  const points = latestHistory.filter((entry) => Number.isFinite(Number(entry.powerW)));
  elements.chartEmpty.hidden = points.length > 1;

  const width = Math.max(320, canvas.clientWidth);
  const height = Math.max(260, canvas.clientHeight);
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  if (points.length < 2) return;

  const padding = { top: 25, right: 22, bottom: 45, left: 58 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxPower = Math.max(10, ...points.map((entry) => Number(entry.peakPowerW || entry.powerW)));
  const chartMax = Math.ceil(maxPower / 10) * 10;

  context.font = "12px IBM Plex Sans, sans-serif";
  context.textBaseline = "middle";
  for (let index = 0; index <= 4; index += 1) {
    const y = padding.top + (plotHeight / 4) * index;
    const value = chartMax - (chartMax / 4) * index;
    context.strokeStyle = "rgba(145, 167, 197, 0.14)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.fillStyle = "#91a7c5";
    context.textAlign = "right";
    context.fillText(`${number(value, 0)} W`, padding.left - 10, y);
  }

  const xFor = (index) => padding.left + (index / (points.length - 1)) * plotWidth;
  const yFor = (value) => padding.top + plotHeight - (Number(value) / chartMax) * plotHeight;
  const gradient = context.createLinearGradient(0, padding.top, 0, padding.top + plotHeight);
  gradient.addColorStop(0, "rgba(255, 190, 92, 0.35)");
  gradient.addColorStop(1, "rgba(255, 190, 92, 0.01)");

  context.beginPath();
  points.forEach((entry, index) => {
    const x = xFor(index);
    const y = yFor(entry.powerW);
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.lineTo(xFor(points.length - 1), padding.top + plotHeight);
  context.lineTo(xFor(0), padding.top + plotHeight);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  points.forEach((entry, index) => {
    const x = xFor(index);
    const y = yFor(entry.powerW);
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.strokeStyle = "#ffbe5c";
  context.lineWidth = 3;
  context.lineJoin = "round";
  context.stroke();

  context.fillStyle = "#ff7f7f";
  points.forEach((entry, index) => {
    const average = Number(entry.powerW);
    const peak = Number(entry.peakPowerW);
    if (!Number.isFinite(peak) || peak <= average) return;
    const x = xFor(index);
    const y = yFor(peak);
    roundedRect(context, x - 1.5, y - 1.5, 3, Math.max(3, yFor(average) - y), 2);
  });

  const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  context.fillStyle = "#91a7c5";
  context.textBaseline = "top";
  labelIndexes.forEach((pointIndex, index) => {
    context.textAlign = index === 0 ? "left" : index === labelIndexes.length - 1 ? "right" : "center";
    context.fillText(formatAxisTime(points[pointIndex].timestamp), xFor(pointIndex), height - padding.bottom + 14);
  });
}

function render(data) {
  const reading = data.reading;
  const online = Boolean(data.online);
  document.body.classList.toggle("energy-offline", !online);
  elements.onlineBadge.classList.toggle("status-online", online);
  elements.onlineBadge.classList.toggle("status-offline", !online);
  setText(elements.onlineBadge, online ? "LIVE" : "OFFLINE");
  setText(elements.topic, data.configuredTopic || "--");
  setText(elements.priceHint, `${number(data.priceEurKwh, 3)} EUR/kWh`);

  if (!reading) {
    setText(elements.sourceStatus, "Wartet auf das Tasmota SENSOR Topic");
    latestHistory = data.history?.points || [];
    drawChart();
    return;
  }

  setText(elements.livePower, number(reading.powerW, 0));
  setText(elements.power, number(reading.powerW, 0));
  setText(elements.voltage, number(reading.voltageV, 0));
  setText(elements.current, number(reading.currentA, 3));
  setText(elements.factor, number(reading.powerFactor, 2));
  setText(elements.today, number(reading.todayKwh, 3));
  setText(elements.costToday, currencyFormat.format(data.estimatedCostTodayEur || 0));
  setText(elements.balanceToday, `${number(reading.todayKwh, 3)} kWh`);
  setText(elements.balanceTodayCost, currencyFormat.format(data.estimatedCostTodayEur || 0));
  setText(elements.yesterday, `${number(reading.yesterdayKwh, 3)} kWh`);
  setText(elements.yesterdayCost, currencyFormat.format(data.estimatedCostYesterdayEur || 0));
  setText(elements.total, `${number(reading.totalKwh, 3)} kWh`);
  setText(elements.totalSince, `Seit ${dateTime(reading.totalStartTime)}`);
  setText(elements.peak, `${number(data.todayStats?.peakPowerW, 0)} W`);
  setText(elements.average, `Durchschnitt ${number(data.todayStats?.averagePowerW, 1)} W`);
  setText(elements.apparent, `${number(reading.apparentPowerVa, 0)} VA`);
  setText(elements.reactive, `${number(reading.reactivePowerVar, 0)} var`);
  setText(elements.voltageRange, `${number(data.todayStats?.minimumVoltageV, 0)} - ${number(data.todayStats?.maximumVoltageV, 0)} V`);
  setText(elements.samples, numberFormat.format(data.todayStats?.samples || 0));
  setText(elements.startTime, dateTime(reading.totalStartTime));
  setText(elements.sourceTime, dateTime(reading.sourceTime));
  setText(elements.sourceStatus, online ? "Messdaten werden empfangen" : "Letzte Messung ist veraltet");
  setText(elements.lastUpdate, `Letzte Aktualisierung ${dateTime(reading.receivedAt)}`);

  const dialPercent = Math.min(100, Math.max(2, Number(reading.todayKwh || 0) * 100));
  elements.dial?.style.setProperty("--dial-progress", `${dialPercent * 3.6}deg`);
  latestHistory = data.history?.points || [];
  drawChart();
}

async function refresh() {
  try {
    const response = await fetch(`/energy/overview?period=${encodeURIComponent(selectedPeriod)}`, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (response.status === 401 || response.redirected) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Unbekannter Fehler");
    setText(elements.error, "");
    render(data);
  } catch (error) {
    setText(elements.error, `Stromdaten konnten nicht geladen werden: ${error.message}`);
  }
}

document.querySelectorAll("[data-period]").forEach((button) => {
  button.addEventListener("click", () => {
    selectedPeriod = button.dataset.period;
    document.querySelectorAll("[data-period]").forEach((entry) => {
      entry.classList.toggle("is-active", entry === button);
    });
    refresh();
  });
});

window.addEventListener("resize", drawChart);
refresh();
setInterval(refresh, 5000);
