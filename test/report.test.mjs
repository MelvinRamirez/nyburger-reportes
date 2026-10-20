import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  defaultStartDate,
  isValidStartDate,
  classifyReportResult,
  buildReportViewModel,
} from '../js/report.js';

function validSalesWindow(overrides = {}) {
  return {
    start_date: '2026-10-10',
    end_date: '2026-10-16',
    days: [
      { date: '2026-10-10', closed: true, order_count: 2, total_amount: 200 },
      { date: '2026-10-11', closed: true, order_count: 1, total_amount: 100 },
    ],
    totals: { order_count: 3, total_amount: 300, avg_ticket: 100 },
    products: [{ item_id: 'p1', name: 'Baleada', quantity: 3, revenue: 150 }],
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, order_count: 0, total_amount: 0 })),
    latest_close_date: '2026-10-16',
    files_read: 2,
    excluded: { undated_count: 0, invalid_total_count: 0, unparsed_details_count: 0, duplicate_count: 0 },
    ...overrides,
  };
}

// --- task 13.1 / defaultStartDate: today (UTC-6) minus 6 days ---

test('defaultStartDate: a UTC instant well within the UTC-6 calendar day returns that day minus 6', () => {
  // 2026-10-16T12:00:00Z shifted by -360min (UTC-6) is 2026-10-16T06:00:00,
  // still the same calendar day in both UTC and UTC-6.
  const nowMs = Date.UTC(2026, 9, 16, 12, 0, 0);
  assert.equal(defaultStartDate(nowMs), '2026-10-10');
});

test('defaultStartDate: distinguishes UTC midnight from UTC-6 midnight (the UTC calendar day has already rolled, the business day has not)', () => {
  // 2026-10-16T04:00:00Z is UTC calendar day 10/16, but shifted by -360min
  // (UTC-6) it is 2026-10-15T22:00:00: the business "today" is still 10/15.
  const nowMs = Date.UTC(2026, 9, 16, 4, 0, 0);
  assert.equal(defaultStartDate(nowMs), '2026-10-09');
});

// --- isValidStartDate: mirrors parseSalesHistoryRequest_'s rule exactly ---

test('isValidStartDate: accepts a well-formed real calendar date', () => {
  assert.equal(isValidStartDate('2026-10-10'), true);
});

test('isValidStartDate: rejects a malformed format', () => {
  assert.equal(isValidStartDate('2026/10/10'), false);
  assert.equal(isValidStartDate('10-10-2026'), false);
  assert.equal(isValidStartDate('2026-10-1'), false);
  assert.equal(isValidStartDate(''), false);
});

test('isValidStartDate: rejects an impossible calendar date despite matching the pattern', () => {
  assert.equal(isValidStartDate('2026-02-30'), false);
  assert.equal(isValidStartDate('2026-13-01'), false);
  assert.equal(isValidStartDate('2026-04-31'), false);
});

test('isValidStartDate: accepts a leap day in a leap year, rejects it in a non-leap year', () => {
  assert.equal(isValidStartDate('2028-02-29'), true);
  assert.equal(isValidStartDate('2026-02-29'), false);
});

test('isValidStartDate: rejects non-string input', () => {
  assert.equal(isValidStartDate(null), false);
  assert.equal(isValidStartDate(undefined), false);
  assert.equal(isValidStartDate(20261010), false);
});

// --- task 12.7: Error States, via classifyReportResult ---

test('classifyReportResult: a successful response with orders classifies as ready', () => {
  const result = classifyReportResult({ kind: 'success', data: validSalesWindow() });
  assert.equal(result.status, 'ready');
  assert.equal(result.window.totals.order_count, 3);
});

test('classifyReportResult: a successful response with zero orders classifies as empty', () => {
  const emptyWindow = validSalesWindow({
    days: [{ date: '2026-10-10', closed: false, order_count: 0, total_amount: 0 }],
    totals: { order_count: 0, total_amount: 0, avg_ticket: null },
    products: [],
  });
  const result = classifyReportResult({ kind: 'success', data: emptyWindow });
  assert.equal(result.status, 'empty');
});

test('classifyReportResult: UNAUTHORIZED classifies as relock, not an in-view error', () => {
  const result = classifyReportResult({ kind: 'definitive', code: 'UNAUTHORIZED', message: '', details: null });
  assert.equal(result.status, 'relock');
});

test('classifyReportResult: ARCHIVE_READ_FAILED and INTERNAL_ERROR classify as retryable error', () => {
  const archiveFailed = classifyReportResult({
    kind: 'definitive',
    code: 'ARCHIVE_READ_FAILED',
    message: '',
    details: { stage: 'read', close_date: '2026-10-12' },
  });
  assert.equal(archiveFailed.status, 'error');
  assert.equal(archiveFailed.code, 'ARCHIVE_READ_FAILED');
  assert.equal(archiveFailed.closeDate, '2026-10-12');

  const internalError = classifyReportResult({ kind: 'definitive', code: 'INTERNAL_ERROR', message: '', details: null });
  assert.equal(internalError.status, 'error');
});

test('classifyReportResult: PIN_NOT_CONFIGURED and CLOSE_NOT_CONFIGURED classify as blocked (non-retryable)', () => {
  const pinNotConfigured = classifyReportResult({ kind: 'definitive', code: 'PIN_NOT_CONFIGURED', message: '', details: null });
  assert.equal(pinNotConfigured.status, 'blocked');

  const closeNotConfigured = classifyReportResult({ kind: 'definitive', code: 'CLOSE_NOT_CONFIGURED', message: '', details: null });
  assert.equal(closeNotConfigured.status, 'blocked');
});

test('classifyReportResult: UNKNOWN_ACTION, INVALID_JSON and VALIDATION_ERROR classify as contract-mismatch, distinct from error and blocked', () => {
  for (const code of ['UNKNOWN_ACTION', 'INVALID_JSON', 'VALIDATION_ERROR']) {
    const result = classifyReportResult({ kind: 'definitive', code, message: '', details: null });
    assert.equal(result.status, 'contract');
    assert.notEqual(result.status, 'error');
    assert.notEqual(result.status, 'blocked');
  }
});

test('classifyReportResult: an ambiguous (network/timeout) failure classifies as unknown, indicating retry is safe', () => {
  const network = classifyReportResult({ kind: 'ambiguous', reason: 'network' });
  assert.equal(network.status, 'unknown');

  const timeout = classifyReportResult({ kind: 'ambiguous', reason: 'timeout' });
  assert.equal(timeout.status, 'unknown');
});

test('classifyReportResult: an unlisted definitive code never crashes, folds into the retryable error bucket', () => {
  const result = classifyReportResult({ kind: 'definitive', code: 'SOME_FUTURE_CODE', message: '', details: null });
  assert.equal(result.status, 'error');
});

// --- task 12.4: order preservation, no client re-sort, XSS-safe text ---

test('buildReportViewModel: preserves data.days order exactly, with no re-sort', () => {
  const window = validSalesWindow({
    days: [
      { date: '2026-10-12', closed: false, order_count: 0, total_amount: 0 },
      { date: '2026-10-10', closed: true, order_count: 2, total_amount: 200 },
      { date: '2026-10-11', closed: true, order_count: 1, total_amount: 100 },
    ],
  });
  const viewModel = buildReportViewModel(window);
  assert.deepStrictEqual(
    viewModel.days.map((d) => d.date),
    ['2026-10-12', '2026-10-10', '2026-10-11'],
  );
});

test('buildReportViewModel: preserves data.products server-given sort exactly, with no client re-sort', () => {
  const window = validSalesWindow({
    products: [
      { item_id: 'p2', name: 'Pollo con tajadas', quantity: 10, revenue: 500 },
      { item_id: 'p1', name: 'Baleada', quantity: 3, revenue: 150 },
      { item_id: 'p3', name: 'Soda', quantity: 20, revenue: 50 },
    ],
  });
  const viewModel = buildReportViewModel(window);
  assert.deepStrictEqual(
    viewModel.products.map((p) => p.itemId),
    ['p2', 'p1', 'p3'],
  );
});

test('buildReportViewModel: a product name containing markup passes through as literal text, unprocessed', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const window = validSalesWindow({ products: [{ item_id: 'p1', name: malicious, quantity: 1, revenue: 10 }] });
  const viewModel = buildReportViewModel(window);
  assert.equal(viewModel.products[0].name, malicious);
});

test('report-view.js never uses innerHTML/outerHTML/insertAdjacentHTML (textContent-only rendering via the shared el() helper)', () => {
  const source = fs.readFileSync(new URL('../js/views/report-view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /innerHTML|outerHTML|insertAdjacentHTML/,
    'report-view.js must render exclusively via el()/textContent, never raw HTML injection',
  );
});

// --- task 12.5: average ticket, null avg_ticket, 24-hour distribution ---

test('buildReportViewModel: a numeric avg_ticket formats as money', () => {
  const window = validSalesWindow({ totals: { order_count: 4, total_amount: 538, avg_ticket: 134.5 } });
  const viewModel = buildReportViewModel(window);
  assert.equal(viewModel.totals.avgTicket, '134.50');
  assert.equal(viewModel.totals.avgTicketNoData, false);
});

test('buildReportViewModel: a null avg_ticket is flagged distinctly from "$0.00" and from loading', () => {
  const window = validSalesWindow({ totals: { order_count: 0, total_amount: 0, avg_ticket: null } });
  const viewModel = buildReportViewModel(window);
  assert.equal(viewModel.totals.avgTicket, null);
  assert.equal(viewModel.totals.avgTicketNoData, true);
  assert.notEqual(viewModel.totals.avgTicket, '0.00');
});

test('buildReportViewModel: all 24 hours are represented, including zero-value hours', () => {
  const window = validSalesWindow({
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, order_count: hour === 13 ? 2 : 0, total_amount: hour === 13 ? 50 : 0 })),
  });
  const viewModel = buildReportViewModel(window);
  assert.equal(viewModel.hours.length, 24);
  assert.deepStrictEqual(
    viewModel.hours.map((h) => h.hour),
    Array.from({ length: 24 }, (_, i) => i),
  );
  // Max-hour bar is full width; every zero hour has a zero-width bar (no
  // division-by-zero artifact anywhere in the series).
  assert.equal(viewModel.hours[13].barWidthPct, 100);
  assert.equal(viewModel.hours[0].barWidthPct, 0);
});

test('buildReportViewModel: bar widths are all zero when every hour totals zero (no division by zero)', () => {
  const window = validSalesWindow({
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, order_count: 0, total_amount: 0 })),
  });
  const viewModel = buildReportViewModel(window);
  for (const hour of viewModel.hours) {
    assert.equal(hour.barWidthPct, 0);
    assert.ok(Number.isFinite(hour.barWidthPct));
  }
});

// --- task 12.6: Distinct Day States ---

test('buildReportViewModel: closed:true renders "Cerrado"', () => {
  const window = validSalesWindow({
    days: [{ date: '2026-10-10', closed: true, order_count: 2, total_amount: 200 }],
    latest_close_date: '2026-10-16',
  });
  const viewModel = buildReportViewModel(window);
  assert.equal(viewModel.days[0].stateLabel, 'Cerrado');
});

test('buildReportViewModel: closed:false on/before latest_close_date renders "Sin cierre"', () => {
  const window = validSalesWindow({
    days: [{ date: '2026-10-12', closed: false, order_count: 0, total_amount: 0 }],
    latest_close_date: '2026-10-16',
  });
  const viewModel = buildReportViewModel(window);
  assert.equal(viewModel.days[0].stateLabel, 'Sin cierre');
  assert.notEqual(viewModel.days[0].stateLabel, 'Cerrado');
});

test('buildReportViewModel: a day with no close but swept-in sales shows "Sin cierre" plus the sweep note', () => {
  const window = validSalesWindow({
    days: [{ date: '2026-10-12', closed: false, order_count: 3, total_amount: 150 }],
    latest_close_date: '2026-10-16',
  });
  const viewModel = buildReportViewModel(window);
  assert.equal(viewModel.days[0].stateLabel, 'Sin cierre');
  assert.equal(viewModel.days[0].sweptNote, true);
});

test('buildReportViewModel: closed:false after latest_close_date renders "Pendiente de cierre", distinct from "Sin cierre"', () => {
  const window = validSalesWindow({
    days: [{ date: '2026-10-18', closed: false, order_count: 0, total_amount: 0 }],
    latest_close_date: '2026-10-16',
  });
  const viewModel = buildReportViewModel(window);
  assert.equal(viewModel.days[0].stateLabel, 'Pendiente de cierre');
  assert.notEqual(viewModel.days[0].stateLabel, 'Sin cierre');
});

test('buildReportViewModel: a fully empty window flags isEmptyWindow and both KPIs as no-data, not zeros', () => {
  const window = validSalesWindow({
    days: [
      { date: '2026-10-10', closed: false, order_count: 0, total_amount: 0 },
      { date: '2026-10-11', closed: false, order_count: 0, total_amount: 0 },
    ],
    totals: { order_count: 0, total_amount: 0, avg_ticket: null },
    products: [],
  });
  const viewModel = buildReportViewModel(window);
  assert.equal(viewModel.isEmptyWindow, true);
  assert.equal(viewModel.totals.noData, true);
  assert.equal(viewModel.totals.avgTicketNoData, true);
});

test('buildReportViewModel: a partial window renders real data alongside empty/pending/sin-cierre days without crashing', () => {
  const window = validSalesWindow({
    days: [
      { date: '2026-10-10', closed: true, order_count: 2, total_amount: 200 },
      { date: '2026-10-11', closed: false, order_count: 0, total_amount: 0 },
      { date: '2026-10-18', closed: false, order_count: 0, total_amount: 0 },
    ],
    totals: { order_count: 2, total_amount: 200, avg_ticket: 100 },
    latest_close_date: '2026-10-16',
  });
  let viewModel;
  assert.doesNotThrow(() => {
    viewModel = buildReportViewModel(window);
  });
  assert.equal(viewModel.isEmptyWindow, false);
  assert.equal(viewModel.isPartialWindow, true);
  assert.equal(viewModel.days[0].stateLabel, 'Cerrado');
  assert.equal(viewModel.days[0].totalAmount, '200.00');
  assert.equal(viewModel.days[1].stateLabel, 'Sin cierre');
  assert.equal(viewModel.days[2].stateLabel, 'Pendiente de cierre');
});

// --- data-quality notes from `excluded` ---

test('buildReportViewModel: generates one note per non-zero excluded counter', () => {
  const window = validSalesWindow({
    excluded: { undated_count: 2, invalid_total_count: 1, unparsed_details_count: 3, duplicate_count: 1 },
  });
  const viewModel = buildReportViewModel(window);
  assert.equal(viewModel.notes.length, 4);
});

test('buildReportViewModel: generates no notes when every excluded counter is zero', () => {
  const window = validSalesWindow();
  const viewModel = buildReportViewModel(window);
  assert.deepStrictEqual(viewModel.notes, []);
});
