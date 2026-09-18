const clockEl = document.getElementById("clock");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function updateClock() {
  if (!clockEl) return;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  clockEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

updateClock();
if (clockEl) setInterval(updateClock, 1000);

function buildNavItems(loggedIn) {
  if (loggedIn) {
    return [
      '<li><a href="/">Übersicht</a></li>',
      '<li><a href="/dashboard">Dashboard</a></li>',
      '<li><a href="/camera">Kamera</a></li>',
      '<li><a href="/console">Konsole</a></li>',
      '<li><a href="/energy">Strom</a></li>',
      '<li><a href="/hydroponic">Hydroponik</a></li>',
      '<li class="logout"><form method="post" action="/login/logout"><button type="submit">Abmelden</button></form></li>',
    ].join("");
  }

  return [
    '<li><a href="/">Übersicht</a></li>',
    '<li><a href="/login">Anmelden</a></li>',
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
    navLinks.id = "primary-navigation";
    markActiveNav(navLinks);

    const toggle = document.createElement("button");
    toggle.className = "navbar-toggle";
    toggle.type = "button";
    toggle.innerHTML = '<span class="nav-toggle-icon" aria-hidden="true"></span><span>Menü</span>';
    toggle.setAttribute("aria-controls", navLinks.id);
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Navigation öffnen");
    navbar.insertBefore(toggle, navLinks);

    const setMenuOpen = (open) => {
      navLinks.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Navigation schließen" : "Navigation öffnen");
    };

    toggle.addEventListener("click", () => {
      setMenuOpen(!navLinks.classList.contains("open"));
    });

    navLinks.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => setMenuOpen(false));
    });

    window.addEventListener("click", (event) => {
      if (!navbar.contains(event.target)) {
        setMenuOpen(false);
      }
    });
    navbar.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && navLinks.classList.contains("open")) {
        setMenuOpen(false);
        toggle.focus();
      }
    });
    window.matchMedia("(max-width: 960px)").addEventListener("change", () => setMenuOpen(false));
  } catch {
    host.innerHTML = '<nav class="navbar" aria-label="Hauptnavigation"><a class="nav-brand" href="/">Smart IoT Ops</a><a href="/login">Anmelden</a></nav>';
  }

  await initBrokerOverview();
})();

async function initBrokerOverview() {
  const summaryEl = document.getElementById("broker-summary");
  if (!summaryEl) return;

  try {
    const readList = async (url) => {
      const response = await fetch(url);
      if (response.status === 401 || response.status === 403) throw new Error("auth");
      if (!response.ok) throw new Error("request");
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error("format");
      return data;
    };
    const [clients, topics] = await Promise.all([
      readList("/api/mqtt/clients"),
      readList("/api/mqtt/topics"),
    ]);

    const onlineCount = Array.isArray(clients) ? clients.filter((c) => c.connected).length : 0;
    const topicCount = Array.isArray(topics) ? topics.length : 0;
    const lastTopic = Array.isArray(topics) && topics.length ? topics[0].topic : "Noch keine Nachrichten";

    summaryEl.innerHTML = [
      `<div class="stats-card"><h3>Broker</h3><div class="stats-val">${onlineCount > 0 ? "ONLINE" : "WARTET"}</div><p>${onlineCount} aktive Clients</p></div>`,
      `<div class="stats-card"><h3>Topics</h3><div class="stats-val">${topicCount}</div><p>${escapeHtml(lastTopic)}</p></div>`,
    ].join("");
  } catch (error) {
    summaryEl.innerHTML = error.message === "auth"
      ? '<div class="helper-box">Deine Live-Messwerte warten auf dich. <a class="summary-login" href="/login">Jetzt anmelden →</a></div>'
      : '<div class="error-msg" role="status">Der Verbindungsstatus ist gerade nicht verfügbar. <button class="btn-secondary" type="button" id="broker-retry">Erneut laden</button></div>';
    document.getElementById("broker-retry")?.addEventListener("click", initBrokerOverview);
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

    body.id ||= `section-content-${index}`;
    const toggle = [...header.querySelectorAll("button[aria-controls]")].find(
      (button) => button.getAttribute("aria-controls") === body.id
    ) || document.createElement("button");
    toggle.type = "button";
    toggle.classList.add("section-toggle");
    toggle.setAttribute("aria-controls", body.id);

    header.appendChild(toggle);
    if (!existingHeader) section.prepend(header);
    if (!body.parentElement) section.appendChild(body);

    const storageKey = `${pageKey}-section-${section.id || index}-collapsed`;
    const applyState = (collapsed) => {
      section.classList.toggle("collapsed", collapsed);
      body.hidden = collapsed;
      toggle.textContent = collapsed ? "Einblenden" : "Ausblenden";
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute("aria-label", `${heading.textContent.trim()}: ${collapsed ? "einblenden" : "ausblenden"}`);
      try { localStorage.setItem(storageKey, String(collapsed)); } catch {}
    };

    let stored = null;
    try { stored = localStorage.getItem(storageKey); } catch {}
    const initialCollapsed = stored === null
      ? section.classList.contains("collapsed") || section.dataset.collapsed === "true"
      : stored === "true";
    applyState(initialCollapsed);

    toggle.addEventListener("click", () => {
      applyState(!section.classList.contains("collapsed"));
    });
    const revealHashTarget = () => {
      if (window.location.hash.slice(1) === section.id && section.id) applyState(false);
    };
    window.addEventListener("hashchange", revealHashTarget);
    document.querySelectorAll('a[href^="#"]').forEach((link) => {
      if (link.getAttribute("href").slice(1) === section.id && section.id) {
        link.addEventListener("click", () => applyState(false));
      }
    });
    revealHashTarget();
  });
})();

(function setupSkipLink() {
  const main = document.querySelector("main");
  if (!main) return;
  main.id ||= "main-content";
  main.tabIndex = -1;
  const link = document.createElement("a");
  link.className = "skip-link";
  link.href = `#${main.id}`;
  link.textContent = "Zum Inhalt springen";
  document.body.prepend(link);
})();
