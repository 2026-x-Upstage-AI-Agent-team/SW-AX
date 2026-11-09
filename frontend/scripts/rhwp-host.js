// Bind the embedded editor's standard Save action to this receipt's version history.
(() => {
  const save = () => window.parent.postMessage({ type: 'swax-save-version' }, location.origin);
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (!['s', 'o', 'n'].includes(key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (key === 's') save();
  }, true);
  window.addEventListener('click', (event) => {
    const item = event.target.closest?.('[data-cmd]');
    if (!item || item.dataset.cmd !== 'file:save') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    save();
  }, true);
  window.addEventListener('drop', (event) => {
    if ([...event.dataTransfer.files].some(file => /\.(hwp|hwpx|hml)$/i.test(file.name))) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
})();
