(() => {
  const stage = document.querySelector('[data-preview-stage]');
  if (!stage) return;

  const cards = stage.querySelectorAll('[data-preview-card]');
  const steps = stage.querySelectorAll('[data-preview-step]');
  const toggle = stage.querySelector('[data-preview-toggle]');
  const motion = window.matchMedia('(min-width: 58rem) and (prefers-reduced-motion: no-preference)');
  const fallbackStage = Number(stage.dataset.previewStage);
  let current = fallbackStage;
  let paused = false;
  let timer;

  function showStage(index) {
    current = index;
    stage.dataset.previewStage = String(index);
    cards.forEach(card => card.setAttribute('aria-hidden', String(Number(card.dataset.previewCard) !== index)));
    steps.forEach(step => {
      const position = Number(step.dataset.previewStep);
      step.classList.toggle('is-complete', position < index);
      step.classList.toggle('is-current', position === index);
      if (position === index) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });
  }

  function schedule() {
    window.clearTimeout(timer);
    if (paused || !motion.matches || document.hidden) return;
    timer = window.setTimeout(() => {
      showStage((current + 1) % steps.length);
      schedule();
    }, current === steps.length - 1 ? 4000 : 2800);
  }

  function syncMotion() {
    toggle.hidden = !motion.matches;
    showStage(motion.matches ? 0 : fallbackStage);
    schedule();
  }

  toggle.addEventListener('click', () => {
    paused = !paused;
    toggle.textContent = paused ? '재생' : '일시정지';
    schedule();
  });
  motion.addEventListener('change', syncMotion);
  document.addEventListener('visibilitychange', schedule);
  syncMotion();
})();
