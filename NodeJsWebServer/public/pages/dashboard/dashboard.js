async function loadMqttClients() {
  const ul = document.getElementById('client-list');
  if (!ul) return;
  ul.innerHTML = '<li>lade …</li>';
  try {
    const list = await fetch('/api/mqtt/clients').then((r) => r.json());
    if (!Array.isArray(list) || list.length === 0) {
      ul.innerHTML = '<li>Keine Clients verbunden</li>';
      return;
    }
    ul.innerHTML = list.map(c => {
      const status = c.connected ? '✅ online' : '⛔ offline';
      const last = new Date(c.last).toLocaleTimeString();
      const topic = c.lastTopic ? ` (letztes Topic: ${c.lastTopic})` : '';
      return `<li>${c.id}: ${status}, zuletzt aktiv ${last}${topic}</li>`;
    }).join('');
  } catch (err) {
    ul.innerHTML = `<li>Fehler beim Laden: ${err}</li>`;
  }
}

async function loadMqttTopics() {
  const ul = document.getElementById('topic-list');
  if (!ul) return;
  ul.innerHTML = '<li>lade …</li>';
  try {
    const list = await fetch('/api/mqtt/topics').then((r) => r.json());
    if (!Array.isArray(list) || list.length === 0) {
      ul.innerHTML = '<li>Keine Topics gefunden</li>';
      return;
    }
    ul.innerHTML = list.map(t => {
      const time = new Date(t.timestamp).toLocaleTimeString();
      return `<li>${t.topic}: ${t.lastMessage} (zuletzt ${time})</li>`;
    }).join('');
  } catch (err) {
    ul.innerHTML = `<li>Fehler beim Laden: ${err}</li>`;
  }
}

loadMqttClients();
loadMqttTopics();
setInterval(loadMqttClients, 10000);
setInterval(loadMqttTopics, 10000);
