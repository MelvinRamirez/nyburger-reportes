import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store.js';
import { initialState } from '../js/actions.js';
import { loadPin, clearPin } from '../js/pin.js';
import { PIN_SESSION_KEY, WINDOW_DAYS } from '../js/config.js';
import * as effects from '../js/effects.js';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
    _data: data,
  };
}

// pin.js keeps a module-level in-memory fallback (so a session survives a
// throwing storage); reset it before every test here so an earlier test's
// savePin doesn't leak into a later test's "stores nothing" assertion.
function resetPinFallback() {
  clearPin(fakeStorage());
}

function fakeApi({ verifyResult }) {
  const calls = [];
  return {
    calls,
    async verifyCajaPin(pin) {
      calls.push(pin);
      return typeof verifyResult === 'function' ? verifyResult(pin) : verifyResult;
    },
  };
}

function makeCtx({ verifyResult, pinStorage = fakeStorage() } = {}) {
  const store = createStore(initialState());
  return { store, api: fakeApi({ verifyResult }), pinStorage };
}

// --- task 9.1: with no stored PIN, only the locked state exists; nothing
// in this ctx ever calls getSalesHistory while locked (there is no such
// wiring at all in work unit R1's main.js/effects.js) ---

test('initialState with no stored PIN starts locked, with no getSalesHistory capability exercised', () => {
  const state = initialState({ hasPin: false });
  assert.equal(state.auth.status, 'locked');
  assert.equal(state.auth.error, null);
});

test('initialState with a stored PIN present starts unlocked (loadPin resolved it before store creation)', () => {
  const state = initialState({ hasPin: true });
  assert.equal(state.auth.status, 'unlocked');
});

// --- task 9.2: successful verifyCajaPin stores the PIN under
// foodc.reportes.pin and transitions to unlocked ---

test('unlock: a successful verifyCajaPin stores the PIN and transitions to unlocked', async () => {
  resetPinFallback();
  const pinStorage = fakeStorage();
  const ctx = makeCtx({
    verifyResult: { kind: 'success', data: { valid: true }, meta: null },
    pinStorage,
  });

  await effects.unlock(ctx, '123456');

  assert.equal(ctx.store.getState().auth.status, 'unlocked');
  assert.equal(ctx.store.getState().auth.error, null);
  assert.equal(loadPin(pinStorage), '123456');
  assert.equal(pinStorage._data[PIN_SESSION_KEY], '123456');
});

// --- task 9.2: UNAUTHORIZED (wrong PIN or the kitchen PIN by mistake)
// stores nothing and keeps the locked state; both handled identically ---

test('unlock: UNAUTHORIZED (wrong PIN) stores no PIN and stays locked', async () => {
  resetPinFallback();
  const pinStorage = fakeStorage();
  const ctx = makeCtx({
    verifyResult: { kind: 'definitive', code: 'UNAUTHORIZED', message: '', details: null },
    pinStorage,
  });

  await effects.unlock(ctx, '000000');

  assert.equal(ctx.store.getState().auth.status, 'locked');
  assert.equal(ctx.store.getState().auth.error, 'wrong_pin');
  assert.equal(loadPin(pinStorage), null);
});

test('unlock: UNAUTHORIZED from submitting the kitchen PIN by mistake is handled identically to any wrong PIN', async () => {
  resetPinFallback();
  const pinStorage = fakeStorage();
  const ctx = makeCtx({
    // requireCajaPin_ rejects the kitchen PIN with the same UNAUTHORIZED
    // code as any other wrong PIN (design Decision 4) — the client makes
    // no distinction, same assertion either way.
    verifyResult: { kind: 'definitive', code: 'UNAUTHORIZED', message: '', details: null },
    pinStorage,
  });

  await effects.unlock(ctx, '999999'); // the kitchen PIN, submitted by mistake

  assert.equal(ctx.store.getState().auth.status, 'locked');
  assert.equal(ctx.store.getState().auth.error, 'wrong_pin');
  assert.equal(loadPin(pinStorage), null);
});

test('unlock: PIN_NOT_CONFIGURED stores no PIN and surfaces a distinct error', async () => {
  resetPinFallback();
  const pinStorage = fakeStorage();
  const ctx = makeCtx({
    verifyResult: { kind: 'definitive', code: 'PIN_NOT_CONFIGURED', message: '', details: null },
    pinStorage,
  });

  await effects.unlock(ctx, '123456');

  assert.equal(ctx.store.getState().auth.status, 'locked');
  assert.equal(ctx.store.getState().auth.error, 'not_configured');
  assert.equal(loadPin(pinStorage), null);
});

// --- task 9.3: ambiguous (network/timeout) failure is distinct from
// UNAUTHORIZED, stores no PIN, leaves submission retryable (status returns
// to 'locked', not stuck in 'verifying') ---

test('unlock: a network/timeout ambiguous failure classifies distinctly from wrong_pin and is retryable', async () => {
  resetPinFallback();
  const pinStorage = fakeStorage();
  const ctx = makeCtx({
    verifyResult: { kind: 'ambiguous', reason: 'network' },
    pinStorage,
  });

  await effects.unlock(ctx, '123456');

  assert.equal(ctx.store.getState().auth.status, 'locked');
  assert.equal(ctx.store.getState().auth.error, 'offline');
  assert.notEqual(ctx.store.getState().auth.error, 'wrong_pin');
  assert.equal(loadPin(pinStorage), null);

  // Retryable: calling unlock again (e.g. the owner presses submit once
  // more) is not blocked by any leftover 'verifying' state.
  const ctx2 = { ...ctx };
  ctx2.api = fakeApi({ verifyResult: { kind: 'success', data: { valid: true }, meta: null } });
  await effects.unlock(ctx2, '123456');
  assert.equal(ctx.store.getState().auth.status, 'unlocked');
});

test('unlock: an ambiguous(timeout) failure also stores no PIN and is distinct from wrong_pin', async () => {
  resetPinFallback();
  const pinStorage = fakeStorage();
  const ctx = makeCtx({
    verifyResult: { kind: 'ambiguous', reason: 'timeout' },
    pinStorage,
  });

  await effects.unlock(ctx, '123456');

  assert.equal(ctx.store.getState().auth.status, 'locked');
  assert.equal(ctx.store.getState().auth.error, 'offline');
  assert.equal(loadPin(pinStorage), null);
});

// --- transient 'verifying' status while the call is in flight ---

test('unlock: dispatches a verifying status before the verifyCajaPin promise resolves', async () => {
  let resolveVerify;
  const ctx = {
    store: createStore(initialState()),
    api: {
      async verifyCajaPin() {
        return new Promise((resolve) => {
          resolveVerify = resolve;
        });
      },
    },
    pinStorage: fakeStorage(),
  };

  const pending = effects.unlock(ctx, '123456');
  assert.equal(ctx.store.getState().auth.status, 'verifying');

  resolveVerify({ kind: 'success', data: { valid: true }, meta: null });
  await pending;
  assert.equal(ctx.store.getState().auth.status, 'unlocked');
});

// --- task 9.5: UNAUTHORIZED on getSalesHistory clears the stored PIN and
// signals relock (effects.relock); a subsequent successful verifyCajaPin
// makes the app usable again ---

test('relock: clears the stored PIN and transitions to locked', () => {
  resetPinFallback();
  const pinStorage = fakeStorage();
  const store = createStore(initialState({ hasPin: true }));
  const ctx = { store, pinStorage };

  effects.relock(ctx, 'rotated');

  assert.equal(store.getState().auth.status, 'locked');
  assert.equal(loadPin(pinStorage), null);
});

test('relock: after relock, a successful verifyCajaPin unlocks again (resuming after a PIN rotation)', async () => {
  resetPinFallback();
  const pinStorage = fakeStorage({ [PIN_SESSION_KEY]: '111111' });
  const store = createStore(initialState({ hasPin: true }));
  const ctx = { store, pinStorage };

  effects.relock(ctx, 'rotated');
  assert.equal(store.getState().auth.status, 'locked');
  assert.equal(loadPin(pinStorage), null);

  ctx.api = fakeApi({ verifyResult: { kind: 'success', data: { valid: true }, meta: null } });
  await effects.unlock(ctx, '222222'); // the new, rotated PIN

  assert.equal(store.getState().auth.status, 'unlocked');
  assert.equal(loadPin(pinStorage), '222222');
});

// =========================================================================
// viewReport (work unit R2, reportes-sales-view)
// =========================================================================

function validSalesWindow(overrides = {}) {
  return {
    start_date: '2026-10-10',
    end_date: '2026-10-16',
    days: [{ date: '2026-10-10', closed: true, order_count: 1, total_amount: 100 }],
    totals: { order_count: 1, total_amount: 100, avg_ticket: 100 },
    products: [],
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, order_count: 0, total_amount: 0 })),
    latest_close_date: '2026-10-16',
    files_read: 1,
    excluded: { undated_count: 0, invalid_total_count: 0, unparsed_details_count: 0, duplicate_count: 0 },
    ...overrides,
  };
}

function makeUnlockedReportCtx({ api, pinStorage = fakeStorage({ [PIN_SESSION_KEY]: '123456' }) } = {}) {
  const store = createStore(initialState({ hasPin: true }));
  return { store, api, pinStorage };
}

// --- task 12.1: "Picking a start date requests a 7-day window" / "No
// request is sent while locked" ---

test('viewReport: an unlocked view sends exactly one getSalesHistory request with days:7', async () => {
  const calls = [];
  const api = {
    async getSalesHistory(startDate, days) {
      calls.push({ startDate, days });
      return { kind: 'success', data: validSalesWindow() };
    },
  };
  const ctx = makeUnlockedReportCtx({ api });

  await effects.viewReport(ctx, '2026-10-10');

  assert.equal(calls.length, 1);
  assert.deepStrictEqual(calls[0], { startDate: '2026-10-10', days: WINDOW_DAYS });
  assert.equal(WINDOW_DAYS, 7);
});

test('viewReport: while the PIN gate is locked, no getSalesHistory request is sent', async () => {
  const calls = [];
  const api = {
    async getSalesHistory(startDate, days) {
      calls.push({ startDate, days });
      return { kind: 'success', data: validSalesWindow() };
    },
  };
  const store = createStore(initialState({ hasPin: false })); // locked
  const ctx = { store, api, pinStorage: fakeStorage() };

  await effects.viewReport(ctx, '2026-10-10');

  assert.equal(calls.length, 0);
  assert.equal(ctx.store.getState().report.status, 'idle');
});

// --- task 12.2: "Changing the date while a request is in flight ignores
// the stale response" ---

test('viewReport: an older response arriving after a newer one is discarded without rendering', async () => {
  let resolveFirst;
  let resolveSecond;
  let callCount = 0;
  const api = {
    calls: [],
    async getSalesHistory(startDate, days) {
      callCount += 1;
      api.calls.push({ startDate, days });
      if (callCount === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return new Promise((resolve) => {
        resolveSecond = resolve;
      });
    },
  };
  const ctx = makeUnlockedReportCtx({ api });

  const firstRequest = effects.viewReport(ctx, '2026-10-01');
  const secondRequest = effects.viewReport(ctx, '2026-10-10');

  resolveSecond({ kind: 'success', data: validSalesWindow({ start_date: '2026-10-10' }) });
  await secondRequest;
  assert.equal(ctx.store.getState().report.viewModel.startDate, '2026-10-10');

  resolveFirst({ kind: 'success', data: validSalesWindow({ start_date: '2026-10-01' }) });
  await firstRequest;

  assert.equal(
    ctx.store.getState().report.viewModel.startDate,
    '2026-10-10',
    'the stale 2026-10-01 response must not overwrite the newer result',
  );
  assert.equal(ctx.store.getState().report.startDate, '2026-10-10');
});

// --- task 12.3: "Loading indicator shown while the request is pending" ---

test('viewReport: status is "loading" from the moment the request is sent until it resolves, with no stale viewModel shown', async () => {
  let resolveIt;
  const api = {
    async getSalesHistory() {
      return new Promise((resolve) => {
        resolveIt = resolve;
      });
    },
  };
  const ctx = makeUnlockedReportCtx({ api });

  const pending = effects.viewReport(ctx, '2026-10-10');
  assert.equal(ctx.store.getState().report.status, 'loading');
  assert.equal(
    ctx.store.getState().report.viewModel,
    null,
    'no stale result must be shown as already answering the new window',
  );

  resolveIt({ kind: 'success', data: validSalesWindow() });
  await pending;
  assert.equal(ctx.store.getState().report.status, 'ready');
});

// --- task 12.8: "UNAUTHORIZED during a view action re-locks instead of
// showing an error banner" ---

test('viewReport: a getSalesHistory UNAUTHORIZED response re-locks instead of ever setting an error/blocked/contract report status', async () => {
  const pinStorage = fakeStorage({ [PIN_SESSION_KEY]: '123456' });
  const api = {
    async getSalesHistory() {
      return { kind: 'definitive', code: 'UNAUTHORIZED', message: '', details: null };
    },
  };
  const ctx = makeUnlockedReportCtx({ api, pinStorage });

  await effects.viewReport(ctx, '2026-10-10');

  assert.equal(ctx.store.getState().auth.status, 'locked');
  assert.equal(loadPin(pinStorage), null);
  assert.notEqual(ctx.store.getState().report.status, 'error');
  assert.notEqual(ctx.store.getState().report.status, 'contract');
  assert.notEqual(ctx.store.getState().report.status, 'blocked');
});

// --- task 12.10: "A request made offline while the app is already open
// fails as an ordinary network error" / "No report data is ever cached for
// offline viewing" ---

test('viewReport: a network failure classifies as "unknown" and never substitutes the prior successful response', async () => {
  let callCount = 0;
  const api = {
    async getSalesHistory() {
      callCount += 1;
      if (callCount === 1) {
        return { kind: 'success', data: validSalesWindow() };
      }
      return { kind: 'ambiguous', reason: 'network' };
    },
  };
  const ctx = makeUnlockedReportCtx({ api });

  await effects.viewReport(ctx, '2026-10-10');
  assert.equal(ctx.store.getState().report.status, 'ready');

  await effects.viewReport(ctx, '2026-10-11');
  assert.equal(ctx.store.getState().report.status, 'unknown');
  assert.equal(
    ctx.store.getState().report.viewModel,
    null,
    'the earlier successful window must not be shown as the answer to the new failed request',
  );
});
