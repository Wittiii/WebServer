const form = document.getElementById('mqtt-form');
const topicInput = document.getElementById('mqtt-topic');
const payloadInput = document.getElementById('mqtt-payload');
const statusEl = document.getElementById('mqtt-status');
const sendBtn = document.getElementById('mqtt-send');

function setStatus(text, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.style.color = isError ? 'crimson' : 'green';
}

if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const topic = topicInput?.value.trim() || '';
    const payload = payloadInput?.value ?? '';

    if (!topic) {
      setStatus('Topic fehlt.', true);
      return;
    }

    if (sendBtn) sendBtn.disabled = true;
    setStatus('Sende...');

    try {
      const res = await fetch('/api/mqtt/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, payload })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok !== true) {
        throw new Error(data.error || 'Publish fehlgeschlagen');
      }

      setStatus('Gesendet.');
    } catch (err) {
      setStatus(`Fehler: ${err.message || err}`, true);
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  });
}
