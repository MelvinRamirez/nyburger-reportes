import { actions } from './actions.js';
import * as pin from './pin.js';
import { classifyReportResult, buildReportViewModel, isValidStartDate } from './report.js';
import { WINDOW_DAYS } from './config.js';

/**
 * Internal engine. `ctx` is created once by `main.js` (the composition
 * root) and shared across every effect call for the life of the page:
 *
 *   ctx.store       - the app's createStore instance
 *   ctx.api         - a createReportesApiClient instance
 *   ctx.pinStorage  - the injected sessionStorage-like object (or null)
 *   ctx.reportSeq   - monotonic request-sequence-number counter (mutable,
 *                     owned by viewReport below; absent/0 until the first
 *                     call)
 *
 * Trimmed from foodc-caja/js/effects.js: no polling loop, no payment
 * runner, no day-close orchestration (design Decision 7). Work unit R1
 * added only the auth slice's effects; work unit R2 adds `viewReport`.
 */

// Codes that indicate a contract bug in the request itself (never a
// data-state mismatch): mirrors foodc-caja's POLL_CONTRACT_ERROR_CODES.
const CONTRACT_ERROR_CODES = new Set(['UNKNOWN_ACTION', 'INVALID_JSON', 'VALIDATION_ERROR']);

// --- re-lock ----------------------------------------------------------

/**
 * Shared re-lock path for "any protected call -> UNAUTHORIZED -> relock"
 * (`reportes-access` "UNAUTHORIZED Response Re-Locks the Screen"): clears
 * the stored PIN and dispatches `actions.relock`. In R1 nothing calls this
 * on a successful getSalesHistory path yet (there is no report fetch
 * wired up until R2); it is exercised directly here against a fake ctx,
 * and against `isRelock` classifying a getSalesHistory UNAUTHORIZED result
 * (task 9.5), since R2's `main.js` wiring is what calls it from a live
 * response.
 *
 * @param {object} ctx
 * @param {string|null} [reason]
 */
export function relock(ctx, reason = null) {
  pin.clearPin(ctx.pinStorage);
  ctx.store.setState((s) => actions.relock(s, { reason }));
}

// --- unlock -------------------------------------------------------------

/**
 * @param {object} ctx
 * @param {string} pinValue
 */
export async function unlock(ctx, pinValue) {
  ctx.store.setState((s) => actions.unlockStarted(s));
  const result = await ctx.api.verifyCajaPin(pinValue);

  if (result.kind === 'success') {
    pin.savePin(ctx.pinStorage, pinValue);
    ctx.store.setState((s) => actions.unlockSucceeded(s));
    return;
  }

  let error;
  if (result.kind === 'definitive' && result.code === 'UNAUTHORIZED') {
    // Covers both an incorrect PIN and the kitchen PIN submitted by
    // mistake: `requireCajaPin_` rejects both identically with
    // UNAUTHORIZED, and this client makes no distinction either (task
    // 9.2, `reportes-access` "Submitting the kitchen PIN is rejected
    // like any other wrong PIN").
    error = 'wrong_pin';
  } else if (result.kind === 'definitive' && result.code === 'PIN_NOT_CONFIGURED') {
    error = 'not_configured';
  } else if (result.kind === 'definitive' && CONTRACT_ERROR_CODES.has(result.code)) {
    error = 'contract';
  } else {
    // 'ambiguous' (network/timeout/invalid_response): task 9.3, distinct
    // from 'wrong_pin', retryable, stores no PIN.
    error = 'offline';
  }
  ctx.store.setState((s) => actions.unlockFailed(s, { error }));
}

// --- report fetching (work unit R2) -------------------------------------

/**
 * Requests a `getSalesHistory` window and renders its outcome, per
 * `reportes-sales-view`:
 *
 * - "No request is sent while locked": a no-op unless `auth.status` is
 *   currently 'unlocked'.
 * - "Picking a start date requests a 7-day window": always passes
 *   `WINDOW_DAYS` (7).
 * - "Loading State While a Request Is Pending": dispatches the 'loading'
 *   status (and clears any prior viewModel) synchronously, before the
 *   `await`.
 * - "A Newer Request Supersedes an Older In-Flight Response": a monotonic
 *   `ctx.reportSeq` counter is captured per call; `actions.reportSettled`
 *   discards the result unless its `seq` is still the latest one.
 * - "UNAUTHORIZED Triggers the Relock Flow, Not an In-View Error": hands
 *   off to `relock` instead of ever setting an error/contract/blocked
 *   report status.
 *
 * @param {object} ctx
 * @param {string} startDate 'yyyy-MM-dd'
 */
export async function viewReport(ctx, startDate) {
  if (ctx.store.getState().auth.status !== 'unlocked') {
    return;
  }
  if (!isValidStartDate(startDate)) {
    return;
  }

  ctx.reportSeq = (ctx.reportSeq || 0) + 1;
  const seq = ctx.reportSeq;
  ctx.store.setState((s) => actions.reportRequested(s, { startDate, seq }));

  const result = await ctx.api.getSalesHistory(startDate, WINDOW_DAYS);
  const classified = classifyReportResult(result);

  if (classified.status === 'relock') {
    relock(ctx, 'unauthorized');
    // Leave no stale 'loading' behind for this (now hidden) report root;
    // actions.reportSettled's own seq guard still protects against a
    // meanwhile-superseded request.
    ctx.store.setState((s) => actions.reportSettled(s, { seq, status: 'idle' }));
    return;
  }

  if (classified.status === 'ready' || classified.status === 'empty') {
    const viewModel = buildReportViewModel(classified.window);
    ctx.store.setState((s) => actions.reportSettled(s, { seq, status: classified.status, viewModel }));
    return;
  }

  // 'error' | 'blocked' | 'contract' | 'unknown'
  ctx.store.setState((s) => actions.reportSettled(s, { seq, status: classified.status, code: classified.code }));
}
