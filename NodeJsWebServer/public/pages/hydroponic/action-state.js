// Keep an operation attached to its object until its UI refresh has completed.
(function (root) {
  let running = false;
  function bind(element, eventName, handler) {
    element?.addEventListener(eventName, async (event) => {
      if (eventName === 'submit') event.preventDefault();
      if (eventName === 'click' && !event.target.closest('button')) return;
      if (running) return;
      running = true;
      const hint = document.getElementById('hydro-action-status');
      const controls = [...document.querySelectorAll(
        '#object-select, #objects-section input, #objects-section button, #mapping-section input, #mapping-section button, #mapping-section select, #automation-section input, #automation-section button, #automation-section select, #delete-readings, #optimize-database'
      )];
      const states = controls.map((control) => [control, control.disabled]);
      controls.forEach((control) => { control.disabled = true; });
      element.setAttribute('aria-busy', 'true');
      hint.textContent = 'Aktion läuft. Die Objektauswahl ist bis zum Abschluss gesperrt.';
      try {
        await handler(event);
      } catch (error) {
        hint.textContent = `Aktion fehlgeschlagen: ${error.message || error}`;
      } finally {
        states.forEach(([control, disabled]) => { if (control.isConnected) control.disabled = disabled; });
        element.setAttribute('aria-busy', 'false');
        if (hint.textContent.startsWith('Aktion läuft.')) hint.textContent = '';
        running = false;
      }
    });
  }
  root.HydroActions = { bind, get busy() { return running; } };
})(globalThis);
