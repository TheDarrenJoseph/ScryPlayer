/**
 * The source picker at the top of the window.
 *
 * A standard ARIA tablist, with a pool of moonlight that slides to sit under
 * whichever source is selected.
 */
export function createPicker(controller) {
  const picker = document.getElementById('picker');
  const glow = document.getElementById('picker-glow');
  const tabs = Array.from(picker.querySelectorAll('.picker__opt'));

  let selectedId = null;

  function moveGlow(tab) {
    // `offsetLeft` is measured from the border box but the glow is positioned
    // against the padding box, so the border width has to come back off.
    glow.style.width = `${tab.offsetWidth}px`;
    glow.style.transform = `translateX(${tab.offsetLeft - picker.clientLeft}px)`;
  }

  function select(id, { focus = false } = {}) {
    const target = tabs.find((t) => t.dataset.source === id);
    if (!target) return;

    selectedId = id;

    for (const tab of tabs) {
      const on = tab === target;
      tab.setAttribute('aria-selected', String(on));
      // Roving tabindex: only the selected tab is in the tab order.
      tab.tabIndex = on ? 0 : -1;

      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) {
        panel.hidden = !on;
        panel.classList.toggle('is-active', on);
      }
    }

    moveGlow(target);
    if (focus) target.focus();

    controller.setActive(id);
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab.dataset.source));
  }

  picker.addEventListener('keydown', (e) => {
    const i = tabs.findIndex((t) => t === document.activeElement);
    if (i < 0) return;

    let next = null;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;

    e.preventDefault();
    select(tabs[next].dataset.source, { focus: true });
  });

  const reposition = () => {
    const current = tabs.find((t) => t.dataset.source === selectedId);
    if (current) moveGlow(current);
  };

  window.addEventListener('resize', reposition);
  // Web fonts land after first paint and change the tab widths under us.
  document.fonts?.ready.then(reposition).catch(() => {});

  return { select };
}
