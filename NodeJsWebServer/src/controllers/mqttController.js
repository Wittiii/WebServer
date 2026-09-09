const { listClientSnapshots, publish, topics } = require('../mqttBroker');

function getClients(req, res) {
  const list = listClientSnapshots();
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
    if (err.code === 'invalid_topic' || err.code === 'payload_too_large') {
      return res.status(400).json({ ok: false, error: err.code });
    }
    console.error('[MQTT] publish request failed', err);
    res.status(500).json({ ok: false, error: 'publish_failed' });
  }
}

module.exports = { getClients, publishMessage, getTopicsWithLastMessage };
