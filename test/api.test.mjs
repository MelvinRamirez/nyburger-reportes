import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReportesApiClient, classifyResponseText, isRelock } from '../js/api.js';

const BASE_URL = 'https://example.test/exec';

function noopTimer() {
  return {
    setTimer: () => 'fake-timer-id',
    clearTimer: () => {},
  };
}

function okResponse(body) {
  return new Response(JSON.stringify(body));
}

function makeClient({ fetchImpl, getPin = () => '123456', ...rest } = {}) {
  return createReportesApiClient({
    baseUrl: BASE_URL,
    getPin,
    fetchImpl,
    timeouts: { verify: 15000, report: 60000 },
    ...noopTimer(),
    ...rest,
  });
}

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

// --- task 9.4 RED test: the PIN must never leak into the request URL, for
// both Reportes actions, including a null stored PIN. Written and confirmed
// failing BEFORE js/api.js existed (no module to import); kept here as the
// permanent regression test, per `reportes-access` "Every Protected Request
// Carries the Stored PIN in Its Body, Never a URL". ---

test('verifyCajaPin never puts the PIN in the request URL, for any pin value', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, data: { valid: true } });
  };
  const client = makeClient({ fetchImpl });

  for (const pin of ['123456', null, '000000000000', '', 'abc123']) {
    await client.verifyCajaPin(pin);
  }

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.url, BASE_URL);
    assert.equal(call.options.method, 'POST');
  }
});

test('verifyCajaPin sends the PIN only in the JSON body', async () => {
  let capturedBody = null;
  const fetchImpl = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return okResponse({ ok: true, data: { valid: true } });
  };
  const client = makeClient({ fetchImpl });
  await client.verifyCajaPin('123456');
  assert.equal(capturedBody.action, 'verifyCajaPin');
  assert.equal(capturedBody.pin, '123456');
});

test('getSalesHistory never puts the PIN in the request URL, for any stored pin value', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, data: validSalesWindow() });
  };

  for (const pin of ['123456', '000000000000']) {
    const client = makeClient({ fetchImpl, getPin: () => pin });
    await client.getSalesHistory('2026-10-10', 7);
  }

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.url, BASE_URL);
  }
});

test('getSalesHistory sends start_date, days and the stored PIN only in the JSON body', async () => {
  let capturedBody = null;
  const fetchImpl = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return okResponse({ ok: true, data: validSalesWindow() });
  };
  const client = makeClient({ fetchImpl, getPin: () => '123456' });
  await client.getSalesHistory('2026-10-10', 7);

  assert.equal(capturedBody.action, 'getSalesHistory');
  assert.equal(capturedBody.pin, '123456');
  assert.equal(capturedBody.start_date, '2026-10-10');
  assert.equal(capturedBody.days, 7);
  assert.equal(new URL(BASE_URL).search, '');
});

test('getSalesHistory with no stored PIN short-circuits to a local UNAUTHORIZED, no fetch call', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, data: validSalesWindow() });
  };
  const client = makeClient({ fetchImpl, getPin: () => null });
  const result = await client.getSalesHistory('2026-10-10', 7);

  assert.equal(calls.length, 0);
  assert.equal(result.kind, 'definitive');
  assert.equal(result.code, 'UNAUTHORIZED');
  assert.equal(isRelock(result), true);
});

// --- task 9.5: a getSalesHistory UNAUTHORIZED response classifies as a
// relock-triggering result (isRelock), same as foodc-caja's own UNAUTHORIZED
// handling; the actual PIN-clear + state transition is exercised in
// effects.test.mjs against effects.relock. ---

test('getSalesHistory UNAUTHORIZED from the server classifies via isRelock', async () => {
  const fetchImpl = async () =>
    okResponse({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid caja PIN' } });
  const client = makeClient({ fetchImpl, getPin: () => '123456' });
  const result = await client.getSalesHistory('2026-10-10', 7);

  assert.equal(result.kind, 'definitive');
  assert.equal(result.code, 'UNAUTHORIZED');
  assert.equal(isRelock(result), true);
});

// --- task 9.3: a network error/timeout is ambiguous, never UNAUTHORIZED ---

test('verifyCajaPin: a network failure classifies as ambiguous(network), not UNAUTHORIZED', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const client = makeClient({ fetchImpl });
  const result = await client.verifyCajaPin('123456');

  assert.equal(result.kind, 'ambiguous');
  assert.equal(result.reason, 'network');
  assert.equal(isRelock(result), false);
});

test('verifyCajaPin: an abort (timeout) classifies as ambiguous(timeout)', async () => {
  let timeoutCallback;
  const fetchImpl = async (url, options) => {
    // Simulate the real AbortController firing before fetch resolves.
    timeoutCallback();
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  const client = makeClient({
    fetchImpl,
    setTimer: (fn) => {
      timeoutCallback = fn;
      return 'fake-timer-id';
    },
    clearTimer: () => {},
  });
  const result = await client.verifyCajaPin('123456');

  assert.equal(result.kind, 'ambiguous');
  assert.equal(result.reason, 'timeout');
});

// --- task 9.7: classifyResponseText / the SalesWindow validator reject a
// malformed response body as a contract-class (ambiguous/invalid_response)
// outcome, never crashing and never silently accepting partial data ---

test('classifyResponseText: a well-formed SalesWindow classifies as success', () => {
  const result = classifyResponseText(
    JSON.stringify({ ok: true, data: validSalesWindow() }),
    (data) => data && typeof data.start_date === 'string',
  );
  assert.equal(result.kind, 'success');
});

test('getSalesHistory: a response missing required SalesWindow fields is rejected as ambiguous(invalid_response), not crashed on and not accepted', async () => {
  const malformed = { start_date: '2026-10-10' }; // missing end_date, days, totals, products, hours, ...
  const fetchImpl = async () => okResponse({ ok: true, data: malformed });
  const client = makeClient({ fetchImpl, getPin: () => '123456' });

  const result = await client.getSalesHistory('2026-10-10', 7);
  assert.equal(result.kind, 'ambiguous');
  assert.equal(result.reason, 'invalid_response');
});

test('getSalesHistory: totals.avg_ticket must be null or a number, never any other type', async () => {
  const malformed = validSalesWindow({ totals: { order_count: 0, total_amount: 0, avg_ticket: 'null' } });
  const fetchImpl = async () => okResponse({ ok: true, data: malformed });
  const client = makeClient({ fetchImpl, getPin: () => '123456' });

  const result = await client.getSalesHistory('2026-10-10', 7);
  assert.equal(result.kind, 'ambiguous');
});

test('getSalesHistory: days/products/hours must be arrays, a non-array is rejected', async () => {
  const malformed = validSalesWindow({ days: 'not-an-array' });
  const fetchImpl = async () => okResponse({ ok: true, data: malformed });
  const client = makeClient({ fetchImpl, getPin: () => '123456' });

  const result = await client.getSalesHistory('2026-10-10', 7);
  assert.equal(result.kind, 'ambiguous');
});

test('getSalesHistory: a genuinely malformed (non-JSON) response body is rejected as ambiguous, not thrown', async () => {
  const fetchImpl = async () => new Response('not json at all');
  const client = makeClient({ fetchImpl, getPin: () => '123456' });

  const result = await client.getSalesHistory('2026-10-10', 7);
  assert.equal(result.kind, 'ambiguous');
  assert.equal(result.reason, 'invalid_response');
});

test('getSalesHistory: a correctly-shaped SalesWindow is accepted as success', async () => {
  const fetchImpl = async () => okResponse({ ok: true, data: validSalesWindow() });
  const client = makeClient({ fetchImpl, getPin: () => '123456' });

  const result = await client.getSalesHistory('2026-10-10', 7);
  assert.equal(result.kind, 'success');
  assert.equal(result.data.start_date, '2026-10-10');
});

// --- classifyResponseText: copied verbatim, same rows as foodc-caja ---

test('classifyResponseText: ok:false with error object classifies as definitive (any code)', () => {
  const result = classifyResponseText(
    JSON.stringify({ ok: false, error: { code: 'ARCHIVE_READ_FAILED', message: 'read failed' } }),
    () => true,
  );
  assert.deepStrictEqual(result, {
    kind: 'definitive',
    code: 'ARCHIVE_READ_FAILED',
    message: 'read failed',
    details: null,
  });
});

test('classifyResponseText: ok:false with an unlisted code is still definitive', () => {
  const result = classifyResponseText(
    JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid caja PIN' } }),
    () => true,
  );
  assert.equal(result.kind, 'definitive');
  assert.equal(result.code, 'UNAUTHORIZED');
});

test('classifyResponseText: ok:true with valid data classifies as success', () => {
  const result = classifyResponseText(JSON.stringify({ ok: true, data: [] }), () => true);
  assert.deepStrictEqual(result, { kind: 'success', data: [], meta: null });
});

test('classifyResponseText: ok:true with data failing validateData classifies as ambiguous(invalid_response)', () => {
  const result = classifyResponseText(JSON.stringify({ ok: true, data: {} }), () => false);
  assert.deepStrictEqual(result, { kind: 'ambiguous', reason: 'invalid_response' });
});

test('classifyResponseText: non-JSON text classifies as ambiguous(invalid_response)', () => {
  const result = classifyResponseText('not json', () => true);
  assert.deepStrictEqual(result, { kind: 'ambiguous', reason: 'invalid_response' });
});

test('classifyResponseText: JSON without a boolean ok field classifies as ambiguous(invalid_response)', () => {
  const result = classifyResponseText(JSON.stringify({ data: {} }), () => true);
  assert.deepStrictEqual(result, { kind: 'ambiguous', reason: 'invalid_response' });
});

test('isRelock: true only for definitive UNAUTHORIZED', () => {
  assert.equal(isRelock({ kind: 'definitive', code: 'UNAUTHORIZED', message: '', details: null }), true);
  assert.equal(isRelock({ kind: 'definitive', code: 'VALIDATION_ERROR', message: '', details: null }), false);
  assert.equal(isRelock({ kind: 'ambiguous', reason: 'network' }), false);
  assert.equal(isRelock({ kind: 'success', data: {}, meta: null }), false);
});
