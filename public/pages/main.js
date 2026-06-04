const btn = document.getElementById("hello-btn");
const messages = document.getElementById("messages");

btn?.addEventListener("click", () => {
  const p = document.createElement("p");
  p.textContent = "Hallo! Schön, dass du klickst.";
  messages.appendChild(p);
});

const clockEl = document.getElementById("clock");

function updateClock() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  if (clockEl) clockEl.textContent = timeStr;
}

updateClock();
setInterval(updateClock, 1000);

(async function loadNavbar() {
  const host = document.getElementById("navbar");
  if (!host) return;

  const html = await fetch("/pages/navbar.html").then((res) => res.text());
  host.innerHTML = html;

  const status = await fetch("/login/status").then((res) => res.json());
  const navLinks = host.querySelector(".nav-links");

  if (status.loggedIn) {
    navLinks.innerHTML = `
      <li><a href="/">Home</a></li>
      <li><a href="/dashboard">Dashboard</a></li>
      <li><a href="/hydroponic">Hydroponik</a></li>
      <li>
        <form method="post" action="/login/logout">
          <button type="submit">Logout</button>
        </form>
      </li>`;
  } else {
    navLinks.innerHTML = `
      <li><a href="/">Home</a></li>
      <li><a href="/login">Login</a></li>`;
  }
})();

// Collapsible sections
(function setupSectionToggles() {
  const sections = document.querySelectorAll("section");
  sections.forEach((section, index) => {
    const heading = section.querySelector("h2, h3");
    if (!heading || section.querySelector(":scope > .section-header")) return;

    section.classList.add("collapsible-section");

    const header = document.createElement("div");
    header.className = "section-header";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "section-toggle";
    toggle.setAttribute("aria-expanded", "true");

    const headingParent = heading.parentNode;
    headingParent.insertBefore(header, heading);
    header.appendChild(heading);
    header.appendChild(toggle);

    const storageKey = `section-${section.id || index}-collapsed`;
    const setCollapsed = (collapsed) => {
      section.classList.toggle("collapsed", collapsed);
      toggle.textContent = collapsed ? "Einblenden" : "Ausblenden";
      toggle.setAttribute("aria-expanded", String(!collapsed));
    };

    setCollapsed(localStorage.getItem(storageKey) === "true");

    toggle.addEventListener("click", () => {
      const collapsed = !section.classList.contains("collapsed");
      setCollapsed(collapsed);
      localStorage.setItem(storageKey, String(collapsed));
    });
  });
})();
