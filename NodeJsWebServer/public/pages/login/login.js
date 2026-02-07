const form = document.getElementById('login-form');
const errorMsg = document.getElementById('login-error');

form?.addEventListener('submit', (event) => {
  errorMsg.hidden = true;

  // Optional: clientseitige Checks
  const username = form.username.value.trim();
  if (username.length < 3) {
    event.preventDefault();
    errorMsg.textContent = 'Nutzername muss mind. 3 Zeichen haben';
    errorMsg.hidden = false;
  }
});
