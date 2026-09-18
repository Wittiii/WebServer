const test = require('node:test');
const assert = require('node:assert/strict');
const dataModule = import('../public/pages/dashboard/dashboard-data.mjs');

test('dashboard search combines client text and connection filters without changing totals', async () => {
  const { filterClients, filterTopics } = await dataModule;
  const clients = [
    { id: 'Greenhouse', connected: true, lastTopic: 'garden/temperature' },
    { id: 'Camera', connected: false, lastTopic: 'garden/image' },
    { id: 'Battery', connected: true },
  ];
  assert.deepEqual(filterClients(clients, ' GARDEN ', 'online'), [clients[0]]);
  assert.deepEqual(filterClients(clients, '', 'offline'), [clients[1]]);
  assert.equal(filterClients(clients, 'missing').length, 0);
  assert.equal(clients.length, 3);
  const topics = [{ topic: 'sensor/temperature', lastMessage: '23.5' }, { topic: 'pump/state', lastMessage: 'OFF' }];
  assert.deepEqual(filterTopics(topics, ' off '), [topics[1]]);
  assert.deepEqual(filterTopics(topics, 'SENSOR'), [topics[0]]);
  assert.equal(filterTopics(topics, '').length, 2);
});

test('topic tree preserves empty levels and topics that also have children', async () => {
  const { createTopicTree } = await dataModule;
  const topics = ['a', 'a/b', 'a//b', '/a', 'a/'].map((topic) => ({ topic }));
  const tree = createTopicTree(topics);
  const a = tree.children.get('a');
  assert.equal(a.topic.topic, 'a');
  assert.equal(a.children.get('b').topic.topic, 'a/b');
  assert.equal(a.children.get('').children.get('b').topic.topic, 'a//b');
  assert.equal(tree.children.get('').children.get('a').topic.topic, '/a');
  assert.equal(a.children.get('').topic.topic, 'a/');
});

test('dashboard requests reject expired sessions and HTTP failures and forward write bodies', async (t) => {
  const { fetchDashboardJson } = await dataModule;
  const requests = [];
  let status = 401;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), { status, headers: { 'Content-Type': 'application/json' } });
  });
  await assert.rejects(fetchDashboardJson('/protected'), /erneut anmelden/);
  status = 503;
  await assert.rejects(fetchDashboardJson('/unavailable'), /HTTP 503/);
  status = 200;
  assert.deepEqual(await fetchDashboardJson('/save', { method: 'PUT', body: '{"widgets":[]}' }), { ok: true });
  assert.equal(requests[2].options.method, 'PUT');
  assert.equal(requests[2].options.body, '{"widgets":[]}');
  assert.ok(requests[2].options.signal instanceof AbortSignal);
});
