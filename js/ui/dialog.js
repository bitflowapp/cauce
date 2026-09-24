// Diálogo accesible para confirmar acciones destructivas y pedir un motivo.
// Reemplaza prompt()/confirm(): se cierra con Escape o "Volver", devuelve el
// foco al botón que lo abrió y nunca confirma por omisión.
import { esc } from './format.js';

export function askReason({ title, message = '', label = 'Motivo', required = true, confirmLabel = 'Confirmar',
  cancelLabel = 'Volver', danger = true, placeholder = '', minLength = 3 } = {}) {
  if (typeof document === 'undefined' || typeof HTMLDialogElement === 'undefined') return Promise.resolve(null);
  const opener = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'cauce-dialog';
  dialog.setAttribute('aria-labelledby', 'cauce-dialog-title');
  dialog.innerHTML = `
    <form method="dialog" class="cauce-dialog-form" novalidate>
      <h2 id="cauce-dialog-title" class="checkout-section-title">${esc(title)}</h2>
      ${message ? `<p class="quiet">${esc(message)}</p>` : ''}
      ${label ? `<div class="field">
        <label for="cauce-dialog-reason">${esc(label)}${required ? '' : ' (opcional)'}</label>
        <textarea id="cauce-dialog-reason" name="reason" rows="3" maxlength="200"
          placeholder="${esc(placeholder)}" ${required ? `required minlength="${minLength}"` : ''}></textarea>
        <p class="field-error" role="alert" hidden></p>
      </div>` : ''}
      <div class="modal-actions">
        <button class="button secondary" type="button" value="cancel" data-dialog-cancel>${esc(cancelLabel)}</button>
        <button class="button ${danger ? 'danger' : ''}" type="submit" value="confirm">${esc(confirmLabel)}</button>
      </div>
    </form>`;
  document.body.append(dialog);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
      resolve(value);
    };
    const form = dialog.querySelector('form');
    const field = dialog.querySelector('textarea');
    const errorText = dialog.querySelector('.field-error');
    dialog.querySelector('[data-dialog-cancel]').addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    form.addEventListener('submit', event => {
      event.preventDefault();
      const reason = (field?.value || '').trim();
      if (field && required && reason.length < minLength) {
        errorText.hidden = false;
        errorText.textContent = `Escribí un motivo de al menos ${minLength} caracteres.`;
        field.setAttribute('aria-invalid', 'true');
        field.focus();
        return;
      }
      finish(field ? reason : '');
    });
    dialog.showModal();
    (field || dialog.querySelector('button[type="submit"]')).focus();
  });
}

export function askConfirm(options) {
  return askReason({ ...options, label: '', required: false }).then(value => value !== null);
}
