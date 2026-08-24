const CLEAR_AFTER = { info: 4000, error: 7000 };

/**
 * The one-line status readout in the top bar.
 *
 * Messages fade on their own — nothing here is important enough to demand a
 * dismissal, and errors linger a little longer than notices.
 */
export function createStatus() {
  const node = document.getElementById('status');
  let timer = 0;

  return function setStatus(text, isError = false) {
    clearTimeout(timer);

    node.textContent = text ?? '';
    node.classList.toggle('is-error', !!isError);

    if (!text) return;

    timer = setTimeout(() => {
      node.textContent = '';
      node.classList.remove('is-error');
    }, isError ? CLEAR_AFTER.error : CLEAR_AFTER.info);
  };
}
