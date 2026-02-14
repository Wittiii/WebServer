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



