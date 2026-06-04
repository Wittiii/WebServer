const clientList = document.getElementById('client-list');
const topicList = document.getElementById('topic-list');
const clientsCountEl = document.getElementById('stats-clients-count');
const topicsCountEl = document.getElementById('stats-topics-count');
const trendCanvas = document.getElementById('dashboard-trend-chart');

let trendHistory = [];
const MAX_TREND_POINTS = 20;

function updateTrendHistory(clientsCount, topicsCount) {
  const now = new Date();
  trendHistory.push({ time: now, clients: clientsCount, topics: topicsCount });
  if (trendHistory.length > MAX_TREND_POINTS) {
    trendHistory.shift();
  }
  drawTrendChart();
}

function drawTrendChart() {
  if (!trendCanvas) return;
  const ctx = trendCanvas.getContext('2d');
  const width = trendCanvas.clientWidth;
  const height = trendCanvas.clientHeight;
  trendCanvas.width = width * (window.devicePixelRatio || 1);
  trendCanvas.height = height * (window.devicePixelRatio || 1);
  ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (!trendHistory.length) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText('Keine Trenddaten verfügbar', 20, 40);
    return;
  }

  const padding = 42;
  const valuesClients = trendHistory.map((entry) => entry.clients);
  const valuesTopics = trendHistory.map((entry) => entry.topics);
  const maxValue = Math.max(...valuesClients, ...valuesTopics, 1);
  const minValue = 0;
  const count = trendHistory.length;
  const stepX = (width - padding * 2) / Math.max(count - 1, 1);

  const renderLine = (values, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    values.forEach((value, index) => {
      const x = padding + stepX * index;
      const y = height - padding - ((value - minValue) / (maxValue - minValue)) * (height - padding * 2);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  renderLine(valuesClients, '#38bdf8');
  renderLine(valuesTopics, '#fbbf24');

  ctx.fillStyle = '#94a3b8';
  ctx.font = '12px system-ui, sans-serif';
  trendHistory.forEach((entry, index) => {
    const x = padding + stepX * index;
    const label = entry.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ctx.fillText(label, x - 24, height - padding + 18);
  });

  ctx.fillStyle = '#38bdf8';
  ctx.fillText('Clients', padding, 18);
  ctx.fillStyle = '#fbbf24';
  ctx.fillText('Topics', padding + 100, 18);
}

async function loadMqttClients() {
  if (!clientList) return;

  try {
    const list = await fetch('/api/mqtt/clients').then((r) => r.json());
    if (!Array.isArray(list)) {
      clientList.innerHTML = '<li class="error-msg">Ungültiges Antwortformat</li>';
      if (clientsCountEl) clientsCountEl.textContent = '0';
      return;
    }

    const onlineClients = list.filter((c) => c.connected).length;
    if (clientsCountEl) clientsCountEl.textContent = onlineClients;

    if (list.length === 0) {
      clientList.innerHTML = '<li style="color: var(--text-muted); justify-content: center;">Keine Clients registriert</li>';
    } else {
      clientList.innerHTML = list
        .map((c) => {
          const badgeClass = c.connected ? 'status-online' : 'status-offline';
          const statusText = c.connected ? 'Online' : 'Offline';
          const statusDot = c.connected ? '<span class="pulse-online"></span>' : '';
          const last = c.last ? new Date(c.last).toLocaleTimeString() : '-';
          const topic = c.lastTopic ? `<span class="obj-topic">Letztes Topic: ${escapeHtml(c.lastTopic)}</span>` : '<span class="obj-topic" style="opacity: 0.5;">Keine Aktivität</span>';
          return `
            <li style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
              <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                <strong class="obj-name" style="font-size: 1.1rem; color: #fff;">${escapeHtml(c.id)}</strong>
                <div style="display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap;">
                  <span class="obj-date">Aktiv: ${last}</span>${topic}
                </div>
              </div>
              <span class="status-badge ${badgeClass}">${statusDot}${statusText}</span>
            </li>`;
        })
        .join('');
    }

  } catch (err) {
    clientList.innerHTML = `<li class="error-msg">Fehler beim Laden: ${escapeHtml(String(err))}</li>`;
    if (clientsCountEl) clientsCountEl.textContent = 'Fehler';
  }
}

async function loadMqttTopics() {
  if (!topicList) return;

  try {
    const list = await fetch('/api/mqtt/topics').then((r) => r.json());
    if (!Array.isArray(list)) {
      topicList.innerHTML = '<li class="error-msg">Ungültiges Antwortformat</li>';
      if (topicsCountEl) topicsCountEl.textContent = '0';
      return;
    }

    if (topicsCountEl) topicsCountEl.textContent = list.length;

    if (list.length === 0) {
      topicList.innerHTML = '<li style="color: var(--text-muted); justify-content: center;">Keine Topics registriert</li>';
    } else {
      topicList.innerHTML = list
        .map((t) => {
          const time = t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : '-';
          return `
            <li style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
              <div style="display: flex; flex-direction: column; gap: 0.25rem; width: 75%;">
                <strong class="obj-name" style="color: var(--accent); font-family: monospace;">${escapeHtml(t.topic)}</strong>
                <span class="obj-date" style="word-break: break-all; background: rgba(0,0,0,0.2); padding: 0.5rem; border-radius: 0.5rem; color: #e2e8f0;">${escapeHtml(t.lastMessage)}</span>
              </div>
              <span class="obj-date" style="white-space: nowrap;">Empfangen: ${time}</span>
            </li>`;
        })
        .join('');
    }

  } catch (err) {
    topicList.innerHTML = `<li class="error-msg">Fehler beim Laden: ${escapeHtml(String(err))}</li>`;
    if (topicsCountEl) topicsCountEl.textContent = 'Fehler';
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function refreshDashboard() {
  await Promise.all([loadMqttClients(), loadMqttTopics()]);
  const clientsCount = Number(clientsCountEl?.textContent || 0);
  const topicsCount = Number(topicsCountEl?.textContent || 0);
  updateTrendHistory(clientsCount, topicsCount);
}

refreshDashboard();
setInterval(refreshDashboard, 10000);
