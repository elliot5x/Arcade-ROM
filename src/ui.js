export function setLiveStatus(element, message, kind = '') {
  element.textContent = message;
  element.dataset.kind = kind;
  element.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
}

export function focusAndSelect(element) {
  if (!element) return;
  element.focus();
  if (typeof element.select === 'function') element.select();
}

export function updateDragState(elements, active) {
  elements.overlay.hidden = !active;
  elements.dropzone.classList.toggle('is-dragging', active);
}
