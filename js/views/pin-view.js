import { messages } from '../messages.js';
import { isValidPinInput } from '../pin.js';
import { PIN_MAX } from '../config.js';
import { select } from '../store.js';
import { el } from './dom.js';

/**
 * `state.auth.error` -> error text per `messages.pin`. A relock (`reason`
 * passed through unchanged from `actions.relock`, which defaults to
 * `null`) renders the plain locked screen with no error banner, same as a
 * freshly-opened tab: `reportes-access` requires only that the screen
 * returns to locked, not a dedicated message.
 *
 * @param {string|null} error
 * @returns {string|null}
 */
function errorMessage(error) {
  if (error === 'wrong_pin') return messages.pin.wrongPin;
  if (error === 'offline') return messages.pin.offline;
  if (error === 'not_configured') return messages.pin.notConfigured;
  if (error === 'contract') return messages.pin.contract;
  return null;
}

/**
 * Pure given `auth` (`{status, error}`).
 *
 * @param {{ status: 'locked'|'verifying'|'unlocked', error: string|null }} auth
 * @returns {DocumentFragment}
 */
function render(auth) {
  const fragment = document.createDocumentFragment();
  const verifying = auth.status === 'verifying';
  const message = errorMessage(auth.error);

  const input = el('input', {
    type: 'text',
    name: 'pin',
    inputmode: 'numeric',
    autocomplete: 'off',
    maxlength: String(PIN_MAX),
    'aria-label': messages.pin.title,
    class: 'pin-view__input',
    disabled: verifying,
  });

  const submitButton = el(
    'button',
    {
      type: 'submit',
      class: 'pin-view__submit',
      disabled: true,
      'data-action': 'unlock-submit',
    },
    [verifying ? messages.pin.title : messages.pin.submit],
  );

  const children = [
    el('h1', { class: 'pin-view__title' }, [messages.pin.title]),
    input,
    submitButton,
  ];
  if (message) {
    children.push(el('p', { class: 'pin-view__error', role: 'alert' }, [message]));
  }

  fragment.appendChild(el('form', { class: 'pin-view__form' }, children));
  return fragment;
}

/**
 * Mounts the blocking PIN screen (`reportes-access` "Blocking PIN Screen on
 * First Open"). `isValidPinInput` is checked HERE, before `handlers.onUnlock`
 * is ever called — the view never calls an effect directly, only emits the
 * `onUnlock(pin)` intent. Copied/adapted from foodc-caja/js/views/pin-view.js
 * (plain class names instead of Tailwind utility classes, see css/app.css).
 *
 * Visibility (whether this root is shown at all) is `main.js`'s concern,
 * based on `auth.status !== 'unlocked'`; this render is always pure given
 * `auth`.
 *
 * @param {HTMLElement} root
 * @param {import('../store.js').createStore<any>} store
 * @param {{ onUnlock: (pin: string) => void }} handlers
 * @returns {() => void} unmount
 */
export function mountPinView(root, store, handlers) {
  function wireInteractivity() {
    const form = root.querySelector('form');
    const input = root.querySelector('input[name="pin"]');
    const button = root.querySelector('[data-action="unlock-submit"]');
    if (!form || !input || !button) return;

    function syncSubmitEnabled() {
      button.disabled = !isValidPinInput(input.value);
    }
    syncSubmitEnabled();

    input.addEventListener('input', () => {
      const digitsOnly = input.value.replace(/[^0-9]/g, '');
      if (digitsOnly !== input.value) input.value = digitsOnly;
      syncSubmitEnabled();
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!isValidPinInput(input.value)) return;
      handlers.onUnlock(input.value);
    });
  }

  function renderNow() {
    root.replaceChildren(render(store.getState().auth));
    wireInteractivity();
  }

  renderNow();
  const unsubscribe = select(store, (state) => state.auth, renderNow);

  return function unmount() {
    unsubscribe();
  };
}
