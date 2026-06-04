const btn = document.getElementById('hello-btn');
const messages = document.getElementById('messages');

btn?.addEventListener('click', () => {
  const p = document.createElement('p');
  p.textContent = 'Hallo! Schön, dass du klickst.';
  messages.appendChild(p);
});


const clockEl = document.getElementById('clock');

function updateClock() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  if (clockEl) clockEl.textContent = timeStr;
}

updateClock();
setInterval(updateClock, 1000);


(async function loadNavbar() {
  const host = document.getElementById('navbar');
  if (!host) return;

  const html = await fetch('/pages/navbar.html').then((res) => res.text());
  host.innerHTML = html;

  const status = await fetch('/login/status').then((res) => res.json());
  const navLinks = host.querySelector('.nav-links');

  if (status.loggedIn) {
    navLinks.innerHTML = `
      <li><a href="/">Home</a></li>
      <li><a href="/dashboard">Dashboard</a></li>
      <li><a href="/hydroponic">Hydroponik</a></li>
      <li class="logout">
        <form method="post" action="/login/logout">
          <button type="submit">Logout</button>
        </form>
      </li>`;
  } else {
    navLinks.innerHTML = `
      <li><a href="/">Home</a></li>
      <li><a href="/login">Login</a></li>`;
  }

  const navbar = host.querySelector('.navbar');
  if (navbar) {
    const toggle = document.createElement('button');
    toggle.className = 'navbar-toggle';
    toggle.type = 'button';
    toggle.innerHTML = '<span class="nav-toggle-icon"></span>';
    navbar.appendChild(toggle);

    toggle.addEventListener('click', () => {
      navLinks.classList.toggle('open');
    });

    window.addEventListener('click', (event) => {
      if (!navbar.contains(event.target) && navLinks.classList.contains('open')) {
        navLinks.classList.remove('open');
      }
    });
  }

  navLinks.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      if (navLinks.classList.contains('open')) {
        navLinks.classList.remove('open');
      }
    });
  });

  await initBrokerOverview();
})();

async function initBrokerOverview() {
  const summaryEl = document.getElementById('broker-summary');
  if (!summaryEl) return;

  try {
    const [clients, topics] = await Promise.all([
      fetch('/api/mqtt/clients').then((r) => r.json()),
      fetch('/api/mqtt/topics').then((r) => r.json())
    ]);

    const onlineCount = Array.isArray(clients) ? clients.filter((c) => c.connected).length : 0;
    const topicCount = Array.isArray(topics) ? topics.length : 0;
    const lastTopic = Array.isArray(topics) && topics.length ? topics[0].topic : 'Noch keine Nachrichten';

    summaryEl.innerHTML = `
      <div class="stats-card">
        <h3>Broker</h3>
        <div class="stats-val">${onlineCount > 0 ? 'ONLINE' : 'KEIN CLIENT'}</div>
        <p>${onlineCount} aktive Clients</p>
      </div>
      <div class="stats-card">
        <h3>Topics</h3>
        <div class="stats-val">${topicCount}</div>
        <p>Neuester Kanal: ${lastTopic}</p>
      </div>
    `;
  } catch (err) {
    summaryEl.innerHTML = '<div class="error-msg">MQTT-Status konnte nicht geladen werden.</div>';
  }
}

// Collapsible sections
(function setupSectionToggles() {
  const sections = document.querySelectorAll('section');
  sections.forEach((section, index) => {
    const heading = section.querySelector('h2, h3');
    if (!heading || section.querySelector(':scope > .section-header')) return;

    section.classList.add('collapsible-section');

    const header = document.createElement('div');
    header.className = 'section-header';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'section-toggle';
    toggle.setAttribute('aria-expanded', 'true');

    const headingParent = heading.parentNode;
    headingParent.insertBefore(header, heading);
    header.appendChild(heading);
    header.appendChild(toggle);

    const storageKey = `section-${section.id || index}-collapsed`;
    const setCollapsed = (collapsed) => {
      section.classList.toggle('collapsed', collapsed);
      toggle.textContent = collapsed ? 'Einblenden' : 'Ausblenden';
      toggle.setAttribute('aria-expanded', String(!collapsed));
    };

    setCollapsed(localStorage.getItem(storageKey) === 'true');

    toggle.addEventListener('click', () => {
      const collapsed = !section.classList.contains('collapsed');
      setCollapsed(collapsed);
      localStorage.setItem(storageKey, String(collapsed));
    });
  });
})();



