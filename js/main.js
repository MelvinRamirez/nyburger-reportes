import { API_URL, VERIFY_TIMEOUT_MS, REPORT_TIMEOUT_MS } from './config.js';
import { createStore, select } from './store.js';
import { initialState } from './actions.js';
import { createReportesApiClient } from './api.js';
import { loadPin } from './pin.js';
import * as effects from './effects.js';
import { defaultStartDate } from './report.js';
import { mountPinView } from './views/pin-view.js';
import { mountReportView } from './views/report-view.js';

/**
 * Reads `sessionStorage` defensively: some private-browsing modes throw on
 * accessing the global object itself, not only on reading/writing a key.
 * Same pattern as `foodc-caja/js/main.js`.
 *
 * @returns {Storage|null}
 */
function getBrowserSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Composition root. Work unit R1 wired only the PIN gate
 * (`reportes-access`); work unit R2 adds the date picker / results view
 * (`reportes-sales-view`), request sequencing, and the `getSalesHistory`
 * UNAUTHORIZED -> `effects.relock` handoff (design Decision 7).
 */
function main() {
  const sessionStorageRef = getBrowserSessionStorage();
  const storedPin = loadPin(sessionStorageRef);

  const store = createStore(initialState({ hasPin: storedPin !== null }));

  const ctx = {
    store,
    api: createReportesApiClient({
      baseUrl: API_URL,
      getPin: () => loadPin(sessionStorageRef),
      timeouts: { verify: VERIFY_TIMEOUT_MS, report: REPORT_TIMEOUT_MS },
    }),
    pinStorage: sessionStorageRef,
  };

  const pinRoot = document.getElementById('pin-root');
  mountPinView(pinRoot, store, {
    onUnlock: (pinValue) => effects.unlock(ctx, pinValue),
  });

  const reportRoot = document.getElementById('report-root');
  const initialStartDate = defaultStartDate(Date.now());
  mountReportView(reportRoot, store, {
    onViewReport: (startDate) => effects.viewReport(ctx, startDate),
  }, initialStartDate);

  // Visibility of the PIN screen vs. the report view is main.js's call
  // (views render unconditionally, pure given state): the report view is
  // only ever shown once unlocked (`reportes-access`; `reportes-sales-view`
  // "No request is sent while locked" relies on this being hidden, not on
  // the user simply not clicking "Ver").
  function syncVisibility(status) {
    pinRoot.hidden = status === 'unlocked';
    reportRoot.hidden = status !== 'unlocked';
  }
  syncVisibility(store.getState().auth.status);
  select(store, (state) => state.auth.status, syncVisibility);

  // Fetch the default window the moment the app becomes unlocked — a
  // stored PIN from a previous session, a fresh unlock, or a resumed
  // session after a relock — so the owner sees data without an extra tap.
  // A relock itself never re-triggers this; the owner explicitly presses
  // "Ver" again after re-entering the PIN.
  select(store, (state) => state.auth.status, (status) => {
    if (status === 'unlocked') {
      effects.viewReport(ctx, initialStartDate);
    }
  });
  if (store.getState().auth.status === 'unlocked') {
    effects.viewReport(ctx, initialStartDate);
  }
}

main();
