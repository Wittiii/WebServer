import { escapeHtml, formatBytes } from "./dashboard-utils.js";

const elements = {
  clients: document.getElementById("client-list"),
  topics: document.getElementById("topic-list"),
  clientsCount: document.getElementById("stats-clients-count"),
  topicsCount: document.getElementById("stats-topics-count"),
  trend: document.getElementById("dashboard-trend-chart"),
  cpuUsage: document.getElementById("server-cpu-usage"),
  cpuMeta: document.getElementById("server-cpu-meta"),
  ramUsage: document.getElementById("server-ram-usage"),
  ramMeta: document.getElementById("server-ram-meta"),
  storageFree: document.getElementById("server-storage-free"),
  storageMeta: document.getElementById("server-storage-meta"),
  dbSize: document.getElementById("server-db-size"),
  dbMeta: document.getElementById("server-db-meta"),
};

const history = [];
const MAX_TREND_POINTS = 20;
let topicTreeInitialized = false;
let openTopicPaths = new Set();

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

function createTopicTree(topics) {
  const root = { children: new Map(), topic: null };
  for (const topic of topics) {
    let node = root;
    for (const segment of String(topic.topic || "").split("/").filter(Boolean)) {
      if (!node.children.has(segment)) node.children.set(segment, { children: new Map(), topic: null });
      node = node.children.get(segment);
    }
    node.topic = topic;
  }
  return root;
}

function countLeaves(node) {
  return (node.topic ? 1 : 0) + [...node.children.values()].reduce((sum, child) => sum + countLeaves(child), 0);
}

function renderTopicNodes(node, depth = 0, parentPath = "") {
  return [...node.children.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([segment, child]) => {
      const topicPath = parentPath ? `${parentPath}/${segment}` : segment;
      const children = renderTopicNodes(child, depth + 1, topicPath);
      const leaf = child.topic
        ? `<div class="mqtt-tree-value" title="${escapeHtml(child.topic.topic)}">
             <span>${escapeHtml(child.topic.lastMessage)}</span>
             <time>${escapeHtml(child.topic.timestamp ? new Date(child.topic.timestamp).toLocaleString() : "-")}</time>
           </div>`
        : "";
      if (!children) {
        return `<li class="mqtt-tree-leaf"><code>${escapeHtml(segment)}</code>${leaf}</li>`;
      }
      const isOpen = topicTreeInitialized ? openTopicPaths.has(topicPath) : depth === 0;
      return `<li class="mqtt-tree-branch">
        <details data-topic-path="${escapeHtml(topicPath)}" ${isOpen ? "open" : ""}>
          <summary><code>${escapeHtml(segment)}</code><span>${countLeaves(child)} Topics</span></summary>
          ${leaf}<ul>${children}</ul>
        </details>
      </li>`;
    })
    .join("");
}

async function loadClients() {
  const list = await fetch("/api/mqtt/clients").then((response) => response.json());
  if (!Array.isArray(list)) throw new Error("ungueltiges Client-Format");
  const online = list.filter((client) => client.connected).length;
  elements.clientsCount.textContent = String(online);
  elements.clients.innerHTML = list.length
    ? list.map((client) => `<li>
        <strong class="obj-name">${escapeHtml(client.id)}</strong>
        <span class="obj-date">${client.last ? new Date(client.last).toLocaleTimeString() : "-"}</span>
        <span class="obj-topic">${escapeHtml(client.lastTopic || "Keine Aktivitaet")}</span>
        <span class="status-badge ${client.connected ? "status-online" : "status-offline"}">${client.connected ? "Online" : "Offline"}</span>
      </li>`).join("")
    : "<li>Keine Clients registriert</li>";
}

async function loadTopics() {
  const list = await fetch("/api/mqtt/topics").then((response) => response.json());
  if (!Array.isArray(list)) throw new Error("ungueltiges Topic-Format");
  if (topicTreeInitialized) {
    openTopicPaths = new Set(
      [...elements.topics.querySelectorAll("details[open][data-topic-path]")]
        .map((details) => details.dataset.topicPath),
    );
  }
  elements.topicsCount.textContent = String(list.length);
  elements.topics.innerHTML = list.length
    ? renderTopicNodes(createTopicTree(list))
    : "<li>Keine Topics registriert</li>";
  topicTreeInitialized = true;
}

async function loadSystem() {
  const response = await fetch("/dashboard/system");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
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

function drawTrend() {
  const canvas = elements.trend;
  if (!canvas || !history.length) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  const context = canvas.getContext("2d");
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const padding = 42;
  const max = Math.max(1, ...history.flatMap((entry) => [entry.clients, entry.topics]));
  const step = (width - padding * 2) / Math.max(1, history.length - 1);
  const draw = (key, color) => {
    context.beginPath();
    context.strokeStyle = color;
    context.lineWidth = 3;
    history.forEach((entry, index) => {
      const x = padding + step * index;
      const y = height - padding - (entry[key] / max) * (height - padding * 2);
      if (index) context.lineTo(x, y); else context.moveTo(x, y);
    });
    context.stroke();
  };
  draw("clients", "#63c8ff");
  draw("topics", "#ffd166");
}

async function refresh() {
  const results = await Promise.allSettled([loadClients(), loadTopics(), loadSystem()]);
  results.forEach((result) => {
    if (result.status === "rejected") console.error("Dashboard refresh:", result.reason);
  });
  history.push({
    clients: Number(elements.clientsCount?.textContent || 0),
    topics: Number(elements.topicsCount?.textContent || 0),
  });
  if (history.length > MAX_TREND_POINTS) history.shift();
  drawTrend();
}

export function initDashboardOverview() {
  refresh();
  setInterval(refresh, 10000);
  window.addEventListener("resize", drawTrend);
}
