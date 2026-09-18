import { escapeHtml, formatBytes } from "./dashboard-utils.js";
import { createTopicTree, filterClients, filterTopics, fetchDashboardJson } from "./dashboard-data.mjs";

const elements = {
  clients: document.getElementById("client-list"),
  topics: document.getElementById("topic-list"),
  clientsCount: document.getElementById("stats-clients-count"),
  topicsCount: document.getElementById("stats-topics-count"),
  cpuUsage: document.getElementById("server-cpu-usage"),
  cpuMeta: document.getElementById("server-cpu-meta"),
  ramUsage: document.getElementById("server-ram-usage"),
  ramMeta: document.getElementById("server-ram-meta"),
  storageFree: document.getElementById("server-storage-free"),
  storageMeta: document.getElementById("server-storage-meta"),
  dbSize: document.getElementById("server-db-size"),
  dbMeta: document.getElementById("server-db-meta"),
};

let topicTreeInitialized = false;
let openTopicPaths = new Set();
let refreshInFlight = false;
let clientsCache = [];
let topicsCache = [];
let lastCompleteRefresh = null;
let topicExpansion = null;
let filterWasActive = false;
const clientSearch = document.getElementById("client-search");
const clientStatus = document.getElementById("client-status-filter");
const topicSearch = document.getElementById("topic-search");
const refreshButton = document.getElementById("dashboard-refresh");
const refreshStatus = document.getElementById("dashboard-refresh-status");
const connection = document.getElementById("dashboard-connection");

function percent(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? `${numeric.toFixed(1)}%` : "-";
}

function severity(value, warnAt, criticalAt) {
  if (value >= criticalAt) return "critical";
  if (value >= warnAt) return "warn";
  return "normal";
}

function applyHealth(element, level) {
  const card = element?.closest(".stats-card");
  if (!card) return;
  card.classList.toggle("health-warn", level === "warn");
  card.classList.toggle("health-critical", level === "critical");
}

function countLeaves(node) {
  return (node.topic ? 1 : 0) + [...node.children.values()].reduce((sum, child) => sum + countLeaves(child), 0);
}

function renderTopicNodes(node, depth = 0, parentSegments = []) {
  return [...node.children.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([segment, child]) => {
      const segments = [...parentSegments, segment];
      const topicPath = JSON.stringify(segments);
      const children = renderTopicNodes(child, depth + 1, segments);
      const leaf = child.topic
        ? `<div class="mqtt-tree-value" title="${escapeHtml(child.topic.topic)}">
             <span>${escapeHtml(child.topic.lastMessage)}</span>
             <time>${escapeHtml(child.topic.timestamp ? new Date(child.topic.timestamp).toLocaleString() : "-")}</time>
           </div>`
        : "";
      if (!children) {
        return `<li class="mqtt-tree-leaf"><code>${escapeHtml(segment || "(leere Ebene)")}</code>${leaf}</li>`;
      }
      const isOpen = topicExpansion ?? (topicSearch.value.trim() ? true : topicTreeInitialized ? openTopicPaths.has(topicPath) : depth === 0);
      return `<li class="mqtt-tree-branch">
        <details data-topic-path="${escapeHtml(topicPath)}" ${isOpen ? "open" : ""}>
          <summary><code>${escapeHtml(segment || "(leere Ebene)")}</code><span>${countLeaves(child)} Topics</span></summary>
          ${leaf}<ul>${children}</ul>
        </details>
      </li>`;
    })
    .join("");
}

async function loadClients() {
  const list = await fetchDashboardJson("/api/mqtt/clients");
  if (!Array.isArray(list)) throw new Error("ungueltiges Client-Format");
  const online = list.filter((client) => client.connected).length;
  elements.clientsCount.textContent = String(online);
  clientsCache = list;
  renderClients();
}

function renderClients() {
  const list = filterClients(clientsCache, clientSearch.value, clientStatus.value);
  document.getElementById("client-result-count").textContent = `${list.length} von ${clientsCache.length} Clients`;
  elements.clients.innerHTML = list.length
    ? list.map((client) => `<li>
        <strong class="obj-name">${escapeHtml(client.id)}</strong>
        <span class="obj-date">${client.last ? new Date(client.last).toLocaleTimeString() : "-"}</span>
        <span class="obj-topic">${escapeHtml(client.lastTopic || "Keine Aktivitaet")}</span>
        <span class="status-badge ${client.connected ? "status-online" : "status-offline"}">${client.connected ? "Online" : "Offline"}</span>
      </li>`).join("")
    : clientsCache.length ? "<li>Keine passenden Clients. Suche oder Filter anpassen.</li>" : "<li>Keine Clients registriert</li>";
}

async function loadTopics() {
  const list = await fetchDashboardJson("/api/mqtt/topics");
  if (!Array.isArray(list)) throw new Error("ungueltiges Topic-Format");
  topicsCache = list;
  elements.topicsCount.textContent = String(list.length);
  renderTopics();
}

function renderTopics() {
  const filtering = Boolean(topicSearch.value.trim());
  if (topicTreeInitialized && !filterWasActive && topicExpansion === null) {
    openTopicPaths = new Set(
      [...elements.topics.querySelectorAll("details[open][data-topic-path]")]
        .map((details) => details.dataset.topicPath),
    );
  }
  const list = filterTopics(topicsCache, topicSearch.value);
  document.getElementById("topic-result-count").textContent = `${list.length} von ${topicsCache.length} Topics`;
  elements.topics.innerHTML = list.length
    ? renderTopicNodes(createTopicTree(list))
    : topicsCache.length ? "<li>Keine passenden Topics. Suche anpassen.</li>" : "<li>Keine Topics registriert</li>";
  topicTreeInitialized = true;
  filterWasActive = filtering;
}

async function loadSystem() {
  const data = await fetchDashboardJson("/dashboard/system");
  const cpu = Number(data?.cpu?.usagePercent || 0);
  applyHealth(elements.cpuUsage, severity(cpu, 65, 85));
  elements.cpuUsage.textContent = percent(cpu);
  elements.cpuMeta.textContent = `${data?.cpu?.cores || "-"} Kerne | Load 1m ${Number(data?.cpu?.loadAverage?.[0] || 0).toFixed(2)}`;

  const ramUsed = Number(data?.memory?.usedBytes || 0);
  const ramTotal = Number(data?.memory?.totalBytes || 0);
  const ramPercent = ramTotal ? (ramUsed / ramTotal) * 100 : 0;
  applyHealth(elements.ramUsage, severity(ramPercent, 75, 90));
  elements.ramUsage.textContent = percent(ramPercent);
  elements.ramMeta.textContent = `${formatBytes(ramUsed)} von ${formatBytes(ramTotal)} belegt`;

  const storageUsed = Number(data?.storage?.usedBytes || 0);
  const storageTotal = Number(data?.storage?.totalBytes || 0);
  const storageFree = Number(data?.storage?.freeBytes || 0);
  const storagePercent = storageTotal ? (storageUsed / storageTotal) * 100 : 0;
  applyHealth(elements.storageFree, severity(storagePercent, 80, 92));
  elements.storageFree.textContent = formatBytes(storageFree);
  elements.storageMeta.textContent = `${formatBytes(storageUsed)} von ${formatBytes(storageTotal)} belegt (${percent(storagePercent)})`;

  const dbSize = Number(data?.database?.sizeBytes || 0);
  applyHealth(elements.dbSize, severity(storageTotal ? (dbSize / storageTotal) * 100 : 0, 10, 20));
  elements.dbSize.textContent = formatBytes(dbSize);
  elements.dbMeta.textContent = `${formatBytes(storageFree)} frei auf dem Server`;
}

async function refresh() {
  if (document.hidden || refreshInFlight) return;
  refreshInFlight = true;
  refreshButton.disabled = true;
  refreshButton.textContent = "Wird aktualisiert …";
  try {
    const results = await Promise.allSettled([loadClients(), loadTopics(), loadSystem()]);
    const names = ["Clients", "Topics", "Serverstatus"];
    const failed = results.flatMap((result, index) => result.status === "rejected" ? [names[index]] : []);
    const failure = results.find((result) => result.status === "rejected");
    connection.textContent = failed.length ? (failed.length === results.length ? "FEHLER" : "TEILWEISE") : "AKTUELL";
    applyHealth(connection, failed.length ? "warn" : "normal");
    if (!failed.length) lastCompleteRefresh = new Date();
    const last = lastCompleteRefresh ? `Letzter vollständiger Abruf: ${lastCompleteRefresh.toLocaleTimeString()}.` : "Noch kein vollständiger Abruf.";
    refreshStatus.textContent = failed.length
      ? `${failed.join(", ")} nicht aktualisiert. ${failure.reason?.message || "Verbindung prüfen."} Vorhandene Werte bleiben stehen. ${last}`
      : `${last} Automatisch alle 10 Sekunden.`;
    refreshStatus.classList.toggle("refresh-error", Boolean(failed.length));
    [elements.clients, elements.topics, document.getElementById("dashboard-server-health")].forEach((element, index) => {
      element.classList.toggle("data-stale", results[index].status === "rejected");
    });
  } finally {
    refreshInFlight = false;
    refreshButton.disabled = false;
    refreshButton.textContent = "Jetzt aktualisieren";
  }
}

export function initDashboardOverview() {
  clientSearch.addEventListener("input", renderClients);
  clientStatus.addEventListener("change", renderClients);
  topicSearch.addEventListener("input", () => { topicExpansion = null; renderTopics(); });
  document.getElementById("topics-expand").addEventListener("click", () => { topicExpansion = true; renderTopics(); });
  document.getElementById("topics-collapse").addEventListener("click", () => { topicExpansion = false; renderTopics(); });
  elements.topics.addEventListener("click", (event) => {
    if (event.target.closest("summary")) topicExpansion = null;
  });
  refreshButton.addEventListener("click", refresh);
  window.addEventListener("online", refresh);
  refresh();
  setInterval(refresh, 10000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
}
