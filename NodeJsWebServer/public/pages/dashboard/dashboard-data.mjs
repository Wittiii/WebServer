export async function fetchDashboardJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Sitzung abgelaufen. Bitte erneut anmelden.");
  }
  if (!response.ok) throw new Error(`Anfrage fehlgeschlagen (HTTP ${response.status}).`);
  return response.json();
}

export function filterClients(clients, query = "", status = "all") {
  const needle = query.trim().toLocaleLowerCase();
  return clients.filter((client) => {
    const matchesStatus = status === "all" || Boolean(client.connected) === (status === "online");
    return matchesStatus && [client.id, client.lastTopic].some((value) =>
      String(value ?? "").toLocaleLowerCase().includes(needle));
  });
}

export function filterTopics(topics, query = "") {
  const needle = query.trim().toLocaleLowerCase();
  return topics.filter((topic) => [topic.topic, topic.lastMessage].some((value) =>
    String(value ?? "").toLocaleLowerCase().includes(needle)));
}

export function createTopicTree(topics) {
  const root = { children: new Map(), topic: null };
  for (const topic of topics) {
    let node = root;
    // Empty MQTT levels are significant: a/b and a//b are different topics.
    for (const segment of String(topic.topic ?? "").split("/")) {
      if (!node.children.has(segment)) node.children.set(segment, { children: new Map(), topic: null });
      node = node.children.get(segment);
    }
    node.topic = topic;
  }
  return root;
}
