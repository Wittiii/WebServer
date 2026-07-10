const btn = document.getElementById("hello-btn");
const messages = document.getElementById("messages");
const clockEl = document.getElementById("clock");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getSectionContentHost(section) {
  return section?.querySelector(":scope > .section-body") || section;
}

btn?.addEventListener("click", () => {
  const target = getSectionContentHost(messages);
  if (!target) return;

  const item = document.createElement("p");
  item.textContent = `Systemgruss um ${new Date().toLocaleTimeString()}: Bedienung bestaetigt.`;
  target.appendChild(item);
});

function updateClock() {
  if (!clockEl) return;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  clockEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

updateClock();
setInterval(updateClock, 1000);

function buildNavItems(loggedIn) {
  if (loggedIn) {
    return [
      '<li><a href="/">Home</a></li>',
      '<li><a href="/dashboard">Dashboard</a></li>',
      '<li><a href="/camera">Kamera</a></li>',
      '<li><a href="/hydroponic">Hydroponik</a></li>',
      '<li class="logout"><form method="post" action="/login/logout"><button type="submit">Logout</button></form></li>',
    ].join("");
  }

  return [
    '<li><a href="/">Home</a></li>',
    '<li><a href="/login">Login</a></li>',
  ].join("");
}

function markActiveNav(navLinks) {
  const current = window.location.pathname.replace(/\/$/, "") || "/";
  navLinks.querySelectorAll("a").forEach((link) => {
    const href = (link.getAttribute("href") || "").replace(/\/$/, "") || "/";
    const active = href === "/" ? current === "/" : current.startsWith(href);
    if (active) {
      link.classList.add("is-active");
      link.setAttribute("aria-current", "page");
    }
  });
}

(async function loadNavbar() {
  const host = document.getElementById("navbar");
  if (!host) return;

  try {
    const html = await fetch("/pages/navbar.html").then((res) => {
      if (!res.ok) throw new Error("navbar");
      return res.text();
    });
    host.innerHTML = html;

    let loggedIn = false;
    try {
      const status = await fetch("/login/status").then((res) => res.json());
      loggedIn = !!status.loggedIn;
    } catch {}

    const navbar = host.querySelector(".navbar");
    const navLinks = host.querySelector(".nav-links");
    if (!navbar || !navLinks) return;

    navLinks.innerHTML = buildNavItems(loggedIn);
    markActiveNav(navLinks);

    const toggle = document.createElement("button");
    toggle.className = "navbar-toggle";
    toggle.type = "button";
    toggle.innerHTML = '<span class="nav-toggle-icon"></span>';
    navbar.appendChild(toggle);

    toggle.addEventListener("click", () => {
      navLinks.classList.toggle("open");
    });

    navLinks.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => navLinks.classList.remove("open"));
    });

    window.addEventListener("click", (event) => {
      if (!navbar.contains(event.target)) {
        navLinks.classList.remove("open");
      }
    });
  } catch {
    host.innerHTML = "";
  }

  await initBrokerOverview();
})();

async function initBrokerOverview() {
  const summaryEl = document.getElementById("broker-summary");
  if (!summaryEl) return;

  try {
    const [clients, topics] = await Promise.all([
      fetch("/api/mqtt/clients").then((r) => r.json()),
      fetch("/api/mqtt/topics").then((r) => r.json()),
    ]);

    const onlineCount = Array.isArray(clients) ? clients.filter((c) => c.connected).length : 0;
    const topicCount = Array.isArray(topics) ? topics.length : 0;
    const lastTopic = Array.isArray(topics) && topics.length ? topics[0].topic : "Noch keine Nachrichten";

    summaryEl.innerHTML = [
      `<div class="stats-card"><h3>Broker</h3><div class="stats-val">${onlineCount > 0 ? "ONLINE" : "WARTET"}</div><p>${onlineCount} aktive Clients</p></div>`,
      `<div class="stats-card"><h3>Topics</h3><div class="stats-val">${topicCount}</div><p>${escapeHtml(lastTopic)}</p></div>`,
    ].join("");
  } catch {
    summaryEl.innerHTML = '<div class="error-msg">MQTT Status konnte nicht geladen werden.</div>';
  }
}

(function setupSectionToggles() {
  const pageKey = (window.location.pathname || "/").replace(/[^\w-]+/g, "_");

  document.querySelectorAll("section").forEach((section, index) => {
    if (section.dataset.collapsibleReady === "true") return;
    if (section.dataset.collapsible === "false" || section.dataset.collapsible === "manual") return;

    const existingHeader = [...section.children].find(
      (child) => child.matches(".section-header, .camera-stream-header") && child.querySelector("h2, h3")
    );
    const heading =
      [...section.children].find((child) => child.matches("h2, h3")) ||
      existingHeader?.querySelector("h2, h3");
    if (!heading) return;

    section.dataset.collapsibleReady = "true";
    section.classList.add("collapsible-section");

    const header = existingHeader || document.createElement("div");
    if (!existingHeader) {
      header.className = "section-header";
      header.appendChild(heading);
    }

    let body = [...section.children].find((child) => child.classList.contains("section-body"));
    if (!body) {
      body = document.createElement("div");
      body.className = "section-body";
      [...section.children].forEach((child) => {
        if (child !== header) body.appendChild(child);
      });
    }

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "section-toggle";

    header.appendChild(toggle);
    if (!existingHeader) section.prepend(header);
    if (!body.parentElement) section.appendChild(body);

    const storageKey = `${pageKey}-section-${section.id || index}-collapsed`;
    const applyState = (collapsed) => {
      section.classList.toggle("collapsed", collapsed);
      body.hidden = collapsed;
      toggle.textContent = collapsed ? "Einblenden" : "Ausblenden";
      toggle.setAttribute("aria-expanded", String(!collapsed));
      localStorage.setItem(storageKey, String(collapsed));
    };

    const stored = localStorage.getItem(storageKey);
    const prefersOpenByDefault = section.id === "dashboard-quick-board";
    const initialCollapsed = stored === null ? !prefersOpenByDefault : stored === "true";
    applyState(initialCollapsed);

    toggle.addEventListener("click", () => {
      applyState(!section.classList.contains("collapsed"));
    });
  });
})();
