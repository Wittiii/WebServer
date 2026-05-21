const { clients, publish, topics } = require('../mqttBroker');
const db = require('../database/db');

function getClients(req, res) {
  const list = [...clients.entries()].map(([id, data]) => ({
    id,
    connected: data.connected,
    last: data.last,
    lastTopic: data.lastTopic || null
  }));
  res.json(list);
}

function getTopicsWithLastMessage(req, res) {
  const list = [...topics.entries()]
    .filter(([topic]) => !topic.startsWith('$SYS/'))
    .map(([topic, data]) => ({
      topic,
      lastMessage: data.lastMessage,
      timestamp: new Date(data.timestamp).toISOString()
    }));
  res.json(list);
}

async function publishMessage(req, res) {
  try {
    const { topic, payload } = req.body || {};
    if (!topic || typeof topic !== 'string' || !topic.trim()) {
      return res.status(400).json({ ok: false, error: 'invalid_topic' });
    }
    const msg = typeof payload === 'string' ? payload : String(payload ?? '');
    await publish(topic.trim(), msg);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}

module.exports = { getClients, publishMessage, getTopicsWithLastMessage };