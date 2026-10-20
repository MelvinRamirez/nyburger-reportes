/**
 * @typedef {{ kind: 'success', data: any, meta: any }
 *   | { kind: 'definitive', code: string, message: string, details: object|null }
 *   | { kind: 'ambiguous', reason: 'network'|'timeout'|'invalid_response' }} ApiResult
 */

/**
 * Clasificador puro del cuerpo de respuesta ya leído como texto. No conoce
 * fetch, timers ni AbortController: solo decide `success` / `definitive` /
 * `ambiguous(invalid_response)` a partir del texto y de `validateData`.
 * Copiado verbatim de foodc-caja/js/api.js (que a su vez lo copió de
 * foodc-kds/js/api.js, que a su vez lo copió de foodc-cliente/js/api.js).
 *
 * @param {string} text
 * @param {(data: any) => boolean} validateData
 * @returns {ApiResult}
 */
export function classifyResponseText(text, validateData) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: 'ambiguous', reason: 'invalid_response' };
  }

  if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') {
    return { kind: 'ambiguous', reason: 'invalid_response' };
  }

  if (body.ok === false) {
    const error = body.error && typeof body.error === 'object' ? body.error : {};
    return {
      kind: 'definitive',
      code: typeof error.code === 'string' ? error.code : 'UNKNOWN_ERROR',
      message: typeof error.message === 'string' ? error.message : '',
      details: error.details ?? null,
    };
  }

  // body.ok === true
  if (!validateData(body.data)) {
    return { kind: 'ambiguous', reason: 'invalid_response' };
  }

  return { kind: 'success', data: body.data, meta: body.meta ?? null };
}

function validateVerifyCajaPinData(data) {
  return data?.valid === true;
}

/**
 * Response-shape validator for the `SalesWindow` typedef (design.md
 * "Request / response shape"). Deliberately checks only the fields and
 * container shapes the client reads, not every nested row's internal
 * fields (`days[*]`, `products[*]`, `hours[*]` are formatted/consumed by
 * `js/report.js` in work unit R2) — a malformed inner row still fails
 * closed there. Here the job is only to reject a response that is not
 * even shaped like a SalesWindow (task 9.7 / `classifyResponseText`'s
 * `ambiguous(invalid_response)` contract-class outcome), never to crash
 * on `null`/non-object input.
 *
 * @param {any} data
 * @returns {boolean}
 */
function isSalesWindowData(data) {
  if (!data || typeof data !== 'object') return false;
  if (typeof data.start_date !== 'string') return false;
  if (typeof data.end_date !== 'string') return false;
  if (!Array.isArray(data.days)) return false;
  if (!data.totals || typeof data.totals !== 'object') return false;
  if (typeof data.totals.order_count !== 'number') return false;
  if (typeof data.totals.total_amount !== 'number') return false;
  if (data.totals.avg_ticket !== null && typeof data.totals.avg_ticket !== 'number') return false;
  if (!Array.isArray(data.products)) return false;
  if (!Array.isArray(data.hours)) return false;
  if (data.latest_close_date !== null && typeof data.latest_close_date !== 'string') return false;
  if (typeof data.files_read !== 'number') return false;
  if (!data.excluded || typeof data.excluded !== 'object') return false;
  return true;
}

const LOCAL_UNAUTHORIZED = Object.freeze({
  kind: 'definitive',
  code: 'UNAUTHORIZED',
  message: '',
  details: null,
});

/**
 * @param {{
 *   baseUrl: string,
 *   getPin: () => string|null,
 *   fetchImpl?: typeof fetch,
 *   timeouts: { verify: number, report: number },
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 * }} options
 */
export function createReportesApiClient({
  baseUrl,
  getPin,
  fetchImpl = globalThis.fetch.bind(globalThis),
  timeouts: { verify, report },
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  /**
   * Fixed POST transport for both Reportes calls. The URL is always
   * exactly `baseUrl` (never a query string), so the PIN can never appear
   * in a URL (task 9.4 RED test; `reportes-access` "Every Protected
   * Request Carries the Stored PIN in Its Body, Never a URL").
   *
   * @param {object} body
   * @param {number} timeoutMs
   * @param {(data: any) => boolean} validateData
   * @returns {Promise<ApiResult>}
   */
  async function post(body, timeoutMs, validateData) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimer(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);

    try {
      const res = await fetchImpl(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      // El timer sigue activo durante la lectura del body.
      const text = await res.text();
      return classifyResponseText(text, validateData);
    } catch {
      return { kind: 'ambiguous', reason: timedOut ? 'timeout' : 'network' };
    } finally {
      clearTimer(timer);
    }
  }

  async function verifyCajaPin(pin) {
    // Deliberately NOT guarded by getPin()===null: verifyCajaPin's whole job
    // is to check a just-entered PIN, which has not been stored via getPin()
    // yet (same reasoning as foodc-caja's verifyCajaPin).
    return post({ action: 'verifyCajaPin', pin }, verify, validateVerifyCajaPinData);
  }

  /**
   * @param {string} startDate 'yyyy-MM-dd'
   * @param {number} [days]
   */
  async function getSalesHistory(startDate, days) {
    const storedPin = getPin();
    if (storedPin === null) {
      return LOCAL_UNAUTHORIZED;
    }
    const body =
      days === undefined
        ? { action: 'getSalesHistory', pin: storedPin, start_date: startDate }
        : { action: 'getSalesHistory', pin: storedPin, start_date: startDate, days };
    return post(body, report, isSalesWindowData);
  }

  return { verifyCajaPin, getSalesHistory };
}

export function isRelock(result) {
  return result.kind === 'definitive' && result.code === 'UNAUTHORIZED';
}
