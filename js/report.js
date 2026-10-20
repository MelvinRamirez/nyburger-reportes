import { SERVER_UTC_OFFSET_MIN } from './config.js';
import { messages } from './messages.js';

/**
 * Pure helpers consumed by `js/effects.js` (request classification) and
 * `js/views/report-view.js` (presentation). Nothing here touches the DOM,
 * `fetch`, timers or storage (design.md "Interfaces / Contracts", `js/report.js`
 * block; design Decision 3: "the client derives a day's label... the client
 * does no aggregation; its pure modules turn the server's aggregates into a
 * view model").
 */

const DATE_PATTERN_ = /^\d{4}-\d{2}-\d{2}$/;

function pad2_(n) {
  return String(n).padStart(2, '0');
}

function formatDateUTC_(date) {
  return `${date.getUTCFullYear()}-${pad2_(date.getUTCMonth() + 1)}-${pad2_(date.getUTCDate())}`;
}

/**
 * "Today" in the business timezone (America/Tegucigalpa, UTC-6, no DST,
 * `SERVER_UTC_OFFSET_MIN`), minus 6 days — the default start date for a
 * 7-day window ending today (design Decision 7).
 *
 * @param {number} nowMs epoch milliseconds (injectable for tests)
 * @returns {string} 'yyyy-MM-dd'
 */
export function defaultStartDate(nowMs) {
  const shifted = new Date(nowMs + SERVER_UTC_OFFSET_MIN * 60000);
  const today = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
  today.setUTCDate(today.getUTCDate() - 6);
  return formatDateUTC_(today);
}

/**
 * Mirrors the backend's `parseSalesHistoryRequest_` rule exactly (design
 * Decision 5): the string must match `yyyy-MM-dd` AND round-trip through
 * `Date.UTC` as a real calendar date, so an impossible date like
 * `2026-02-30` (which matches the pattern) is still rejected.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isValidStartDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN_.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

// Error-code buckets per design's `classifyReportResult` mapping and
// `reportes-sales-view`'s "Error States Map to Distinct, Actionable
// Messages" requirement.
const RETRYABLE_ERROR_CODES = new Set(['ARCHIVE_READ_FAILED', 'INTERNAL_ERROR']);
const BLOCKED_CODES = new Set(['PIN_NOT_CONFIGURED', 'CLOSE_NOT_CONFIGURED']);
const CONTRACT_CODES = new Set(['UNKNOWN_ACTION', 'INVALID_JSON', 'VALIDATION_ERROR']);

/**
 * @typedef {{ status: 'ready', window: object }
 *   | { status: 'empty', window: object }
 *   | { status: 'relock' }
 *   | { status: 'error', code: string, closeDate?: string }
 *   | { status: 'blocked', code: string }
 *   | { status: 'contract', code: string }
 *   | { status: 'unknown' }} ReportClassification
 */

/**
 * Classifies a `getSalesHistory` `ApiResult` (js/api.js) into the status
 * vocabulary `js/views/report-view.js` renders. Never throws: an unlisted
 * `definitive` code is treated as a retryable error rather than crashing
 * the view.
 *
 * @param {import('./api.js').ApiResult} apiResult
 * @returns {ReportClassification}
 */
export function classifyReportResult(apiResult) {
  if (apiResult.kind === 'success') {
    const window = apiResult.data;
    return { status: window.totals.order_count === 0 ? 'empty' : 'ready', window };
  }

  if (apiResult.kind === 'definitive') {
    const { code, details } = apiResult;

    if (code === 'UNAUTHORIZED') {
      // `reportes-sales-view` "UNAUTHORIZED Triggers the Relock Flow, Not
      // an In-View Error": the caller hands off to effects.relock, never
      // renders this as an in-view error.
      return { status: 'relock' };
    }
    if (RETRYABLE_ERROR_CODES.has(code)) {
      return {
        status: 'error',
        code,
        closeDate: details && typeof details === 'object' ? details.close_date : undefined,
      };
    }
    if (BLOCKED_CODES.has(code)) {
      return { status: 'blocked', code };
    }
    if (CONTRACT_CODES.has(code)) {
      return { status: 'contract', code };
    }
    // An unexpected/unlisted definitive code is still actionable, not a
    // crash: fold it into the same retryable-error bucket.
    return { status: 'error', code };
  }

  // 'ambiguous' (network/timeout/invalid_response): getSalesHistory is
  // read-only, so retry is always safe.
  return { status: 'unknown' };
}

function formatMoney_(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '--';
}

/**
 * Derives a day's state per design's "Response shape / client derives a
 * day's label" and `reportes-sales-view`'s "Distinct Day States" requirement.
 *
 * @param {{date: string, closed: boolean, order_count: number}} day
 * @param {?string} latestCloseDate
 */
function dayState_(day, latestCloseDate) {
  if (day.closed) {
    return { label: messages.report.dayState.closed, sweptNote: false };
  }
  const onOrBeforeLatestClose = latestCloseDate !== null && day.date <= latestCloseDate;
  if (onOrBeforeLatestClose) {
    return { label: messages.report.dayState.sinCierre, sweptNote: day.order_count > 0 };
  }
  return { label: messages.report.dayState.pendiente, sweptNote: false };
}

/**
 * Turns a `SalesWindow` (design.md typedef, consumed verbatim — no
 * client-side aggregation or re-sorting) into the plain view model
 * `js/views/report-view.js` renders via `textContent` only.
 *
 * @param {object} window `SalesWindow`
 */
export function buildReportViewModel(window) {
  const latestCloseDate = window.latest_close_date;

  // `.map` preserves `data.days`'s order exactly (reportes-sales-view
  // "Per-date rows render in window order").
  const days = window.days.map((day) => {
    const state = dayState_(day, latestCloseDate);
    return {
      date: day.date,
      orderCount: day.order_count,
      totalAmount: formatMoney_(day.total_amount),
      stateLabel: state.label,
      sweptNote: state.sweptNote,
    };
  });

  // `.map` preserves `data.products`'s server-given sort exactly (revenue
  // desc, then quantity desc, then key) — no client-side re-sort
  // (reportes-sales-view "Per-product breakdown renders in server-returned
  // order"). `name` passes through unprocessed: it is only ever consumed
  // via `textContent` downstream (js/views/dom.js's `el()`), never
  // interpreted as markup, so a malicious name stays literal text.
  const products = window.products.map((product) => ({
    itemId: product.item_id,
    name: product.name,
    quantity: product.quantity,
    revenue: formatMoney_(product.revenue),
  }));

  const maxHourAmount = window.hours.reduce((max, hour) => Math.max(max, hour.total_amount), 0);
  const hours = window.hours.map((hour) => ({
    hour: hour.hour,
    orderCount: hour.order_count,
    totalAmount: formatMoney_(hour.total_amount),
    // Pure bar width, no chart library: 0 when every hour is zero (avoids
    // a division by zero), otherwise this hour's share of the window's
    // busiest hour.
    barWidthPct: maxHourAmount > 0 ? Math.round((hour.total_amount / maxHourAmount) * 100) : 0,
  }));

  const isEmptyWindow = window.totals.order_count === 0;
  const avgTicketValue = window.totals.avg_ticket;
  const totals = {
    orderCount: window.totals.order_count,
    totalAmount: formatMoney_(window.totals.total_amount),
    avgTicket: avgTicketValue === null ? null : formatMoney_(avgTicketValue),
    // Distinct from a loading state and from "$0.00": true whenever the
    // server itself reports no data to average (reportes-sales-view "Null
    // avg_ticket shows a distinct no-data state").
    avgTicketNoData: avgTicketValue === null,
    // A fully empty window shows BOTH KPIs as "no data", not zeros
    // (reportes-sales-view "A fully empty window shows a clear empty
    // state, not zeros").
    noData: isEmptyWindow,
  };

  const excluded = window.excluded || {};
  const notes = [];
  if (excluded.duplicate_count > 0) {
    notes.push(messages.report.dataQuality.duplicates(excluded.duplicate_count));
  }
  if (excluded.undated_count > 0) {
    notes.push(messages.report.dataQuality.undated(excluded.undated_count));
  }
  if (excluded.invalid_total_count > 0) {
    notes.push(messages.report.dataQuality.invalidTotal(excluded.invalid_total_count));
  }
  if (excluded.unparsed_details_count > 0) {
    notes.push(messages.report.dataQuality.unparsedDetails(excluded.unparsed_details_count));
  }

  return {
    startDate: window.start_date,
    endDate: window.end_date,
    latestCloseDate,
    filesRead: window.files_read,
    days,
    products,
    hours,
    totals,
    isEmptyWindow,
    // A partial window: some data, some empty days, nothing crashes
    // (reportes-sales-view "A partial window shows correct data for closed
    // days alongside empty ones").
    isPartialWindow: !isEmptyWindow && days.some((d) => d.orderCount === 0),
    notes,
  };
}
