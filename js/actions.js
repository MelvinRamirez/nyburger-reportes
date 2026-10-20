/**
 * Store state shape (Reportes), trimmed from foodc-caja/js/actions.js: only
 * the `auth` slice survived work unit R1 (design Decision 7, "Client =
 * foodc-caja skeleton minus polling and queues"). Work unit R2 adds the
 * `report` slice: request sequencing (supersede-by-sequence-number) and the
 * loading/ready/empty/error/blocked/contract/unknown status vocabulary from
 * `js/report.js`'s `classifyReportResult`.
 *
 * {
 *   auth: { status: 'locked'|'verifying'|'unlocked',
 *           error: null|'wrong_pin'|'offline'|'not_configured'|'contract' },
 *   report: { status: 'idle'|'loading'|'ready'|'empty'|'error'|'unknown'|'blocked'|'contract',
 *             startDate: string|null, seq: number,
 *             viewModel: object|null, code: string|null },
 * }
 *
 * @param {{ hasPin?: boolean }} [hydrated]
 */
export function initialState({ hasPin = false } = {}) {
  return {
    auth: { status: hasPin ? 'unlocked' : 'locked', error: null },
    report: { status: 'idle', startDate: null, seq: 0, viewModel: null, code: null },
  };
}

export const actions = {
  unlockStarted(state) {
    return { ...state, auth: { status: 'verifying', error: null } };
  },

  unlockSucceeded(state) {
    return { ...state, auth: { status: 'unlocked', error: null } };
  },

  unlockFailed(state, { error }) {
    return { ...state, auth: { status: 'locked', error } };
  },

  // Re-lock (on a getSalesHistory UNAUTHORIZED, `reportes-access` "UNAUTHORIZED
  // Response Re-Locks the Screen") never needs a dedicated error banner text:
  // the owner is simply returned to a plain PIN screen, same posture as the
  // kitchen-PIN rejection case, so `reason` is accepted but not required to
  // map to a message in js/messages.js.
  relock(state, { reason = null } = {}) {
    return { ...state, auth: { status: 'locked', error: reason } };
  },

  // --- report slice (work unit R2) ---

  /**
   * Dispatched synchronously the moment a `getSalesHistory` request is
   * sent, before the response arrives: clears any previous viewModel so a
   * stale window is never presented as already answering the new one
   * (`reportes-sales-view` "Loading State While a Request Is Pending").
   * `seq` is the monotonic request-sequence-number `js/effects.js`
   * maintains; it is the only thing `reportSettled` below checks to decide
   * whether a later-arriving response is still the current one.
   */
  reportRequested(state, { startDate, seq }) {
    return {
      ...state,
      report: { ...state.report, status: 'loading', startDate, seq, viewModel: null, code: null },
    };
  },

  /**
   * Applies a resolved (or relock-reset) `getSalesHistory` outcome, but
   * ONLY if `seq` still matches the latest request's sequence number —
   * otherwise this is a stale, superseded response and the state is
   * returned unchanged (`reportes-sales-view` "A Newer Request Supersedes
   * an Older In-Flight Response": discarded without rendering).
   */
  reportSettled(state, { seq, status, viewModel = null, code = null }) {
    if (seq !== state.report.seq) {
      return state;
    }
    return { ...state, report: { ...state.report, status, viewModel, code } };
  },
};
