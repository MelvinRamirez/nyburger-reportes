import { messages } from '../messages.js';
import { isValidStartDate } from '../report.js';
import { select } from '../store.js';
import { el } from './dom.js';

/**
 * Results view (`reportes-sales-view`). Every piece of sheet-derived text
 * (product names in particular) is rendered exclusively through `el()`
 * (js/views/dom.js), which only ever uses `textContent`/`createTextNode`
 * and never parses a string as markup, so a product name like
 * `<img src=x onerror=alert(1)>` is always literal text, never executed or
 * injected into the DOM as an element ("Per-product breakdown rendering" /
 * "Product names never execute as HTML"). No chart library: the hourly
 * distribution is plain `div` bars whose widths come pre-computed from
 * `js/report.js`'s pure view model (design Decision 7, C1 zero-runtime-
 * dependency rule).
 */

function kpiBlock_(label, value) {
  return el('div', { class: 'report-kpi' }, [
    el('span', { class: 'report-kpi__label' }, [label]),
    el('span', { class: 'report-kpi__value' }, [value]),
  ]);
}

function renderKpis_(totals) {
  const noDataText = messages.report.kpis.avgTicketNoData;
  return el('div', { class: 'report-kpis' }, [
    kpiBlock_(messages.report.kpis.totalSales, totals.noData ? noDataText : totals.totalAmount),
    kpiBlock_(messages.report.kpis.orderCount, totals.noData ? noDataText : String(totals.orderCount)),
    kpiBlock_(messages.report.kpis.avgTicket, totals.avgTicketNoData ? noDataText : totals.avgTicket),
  ]);
}

function renderDayRow_(day) {
  const children = [
    el('span', { class: 'report-day__date' }, [day.date]),
    el('span', { class: 'report-day__state' }, [day.stateLabel]),
    el('span', { class: 'report-day__orders' }, [String(day.orderCount)]),
    el('span', { class: 'report-day__amount' }, [day.totalAmount]),
  ];
  if (day.sweptNote) {
    children.push(el('span', { class: 'report-day__note' }, [messages.report.dayState.sinCierreNote]));
  }
  return el('li', { class: 'report-day' }, children);
}

function renderProductRow_(product) {
  return el('li', { class: 'report-product' }, [
    // product.name is sheet-derived, untrusted text: it reaches here as a
    // plain JS string, and `el()`'s children are always attached via
    // `document.createTextNode`, never parsed as HTML.
    el('span', { class: 'report-product__name' }, [product.name]),
    el('span', { class: 'report-product__quantity' }, [String(product.quantity)]),
    el('span', { class: 'report-product__revenue' }, [product.revenue]),
  ]);
}

function renderHourBar_(hour) {
  const bar = el('div', { class: 'report-hour__bar' });
  bar.style.width = `${hour.barWidthPct}%`;
  return el('li', { class: 'report-hour' }, [
    el('span', { class: 'report-hour__label' }, [String(hour.hour)]),
    bar,
    el('span', { class: 'report-hour__amount' }, [hour.totalAmount]),
  ]);
}

function renderReady_(viewModel) {
  const fragment = document.createDocumentFragment();

  fragment.appendChild(renderKpis_(viewModel.totals));

  if (viewModel.isEmptyWindow) {
    fragment.appendChild(el('p', { class: 'report-view__empty' }, [messages.report.emptyWindow]));
    return fragment;
  }

  fragment.appendChild(el('ul', { class: 'report-view__days' }, viewModel.days.map(renderDayRow_)));

  fragment.appendChild(el('h2', { class: 'report-view__section-title' }, [messages.report.products.title]));
  fragment.appendChild(
    viewModel.products.length > 0
      ? el('ul', { class: 'report-view__products' }, viewModel.products.map(renderProductRow_))
      : el('p', { class: 'report-view__empty' }, [messages.report.products.empty]),
  );

  fragment.appendChild(el('h2', { class: 'report-view__section-title' }, [messages.report.hours.title]));
  fragment.appendChild(el('ul', { class: 'report-view__hours' }, viewModel.hours.map(renderHourBar_)));

  if (viewModel.notes.length > 0) {
    fragment.appendChild(
      el(
        'ul',
        { class: 'report-view__notes' },
        viewModel.notes.map((note) => el('li', { class: 'report-view__note' }, [note])),
      ),
    );
  }

  return fragment;
}

/**
 * Pure given the `report` slice (`{status, startDate, seq, viewModel, code}`).
 *
 * @param {object} report
 * @returns {DocumentFragment}
 */
function renderReportState(report) {
  const fragment = document.createDocumentFragment();

  if (report.status === 'idle') {
    return fragment; // nothing requested yet
  }

  if (report.status === 'loading') {
    // No stale result is ever shown here: reportRequested clears viewModel
    // synchronously, so a prior window's numbers can never be mistaken for
    // the answer to the newly selected one.
    fragment.appendChild(el('p', { class: 'report-view__loading', 'aria-live': 'polite' }, [messages.report.loading]));
    return fragment;
  }

  if (report.status === 'ready' || report.status === 'empty') {
    fragment.appendChild(renderReady_(report.viewModel));
    return fragment;
  }

  // 'error' | 'blocked' | 'contract' | 'unknown'
  const message = messages.report.errors[report.status] || messages.report.errors.error;
  fragment.appendChild(
    el(
      'p',
      { class: `report-view__message report-view__message--${report.status}`, role: 'alert' },
      [message],
    ),
  );
  return fragment;
}

/**
 * Mounts the date picker + "Ver" action header (stable across re-renders,
 * so the date input never loses its value/focus mid-request) and the
 * reactive results region below it.
 *
 * @param {HTMLElement} root
 * @param {import('../store.js').createStore<any>} store
 * @param {{ onViewReport: (startDate: string) => void }} handlers
 * @param {string} initialStartDate 'yyyy-MM-dd' (js/report.js's defaultStartDate)
 * @returns {() => void} unmount
 */
export function mountReportView(root, store, handlers, initialStartDate) {
  const dateInput = el('input', {
    type: 'date',
    name: 'start-date',
    value: initialStartDate,
    'aria-label': messages.report.startDateLabel,
    class: 'report-view__date-input',
  });

  const viewButton = el(
    'button',
    { type: 'button', class: 'report-view__view-button', 'data-action': 'view-report' },
    [messages.report.viewAction],
  );

  const resultsRoot = el('div', { class: 'report-view__results' });

  root.replaceChildren(
    el('div', { class: 'report-view__header' }, [
      el('label', { class: 'report-view__date-label' }, [messages.report.startDateLabel]),
      dateInput,
      viewButton,
    ]),
    resultsRoot,
  );

  function triggerView() {
    const value = dateInput.value;
    if (!isValidStartDate(value)) {
      return; // reportes-sales-view: only a valid date triggers a request
    }
    handlers.onViewReport(value);
  }
  viewButton.addEventListener('click', triggerView);

  function renderResults() {
    resultsRoot.replaceChildren(renderReportState(store.getState().report));
  }
  renderResults();
  const unsubscribe = select(store, (state) => state.report, renderResults);

  return function unmount() {
    unsubscribe();
    viewButton.removeEventListener('click', triggerView);
  };
}
