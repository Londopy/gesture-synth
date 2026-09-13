import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CommunityApi, HOSTED_RETRY, LOCAL_RETRY, WAKE_NOTICE_MS } from './api';

const BASE = 'https://gesture-synth-api.onrender.com';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function status(code: number, text = '') {
  return new Response(text, { status: code });
}
/** fetch that never answers and rejects with the signal's reason once aborted. */
function hang(): typeof fetch {
  return (_url, init) =>
    new Promise((_, reject) => {
      const signal = (init as RequestInit).signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

/** Runs `p` under fake timers, advancing until it settles; fetch mocks resolve as microtasks. */
async function settle<T>(p: Promise<T>, ms: number): Promise<T> {
  // Attach a no-op handler so a rejection that is asserted later is not reported as unhandled.
  p.catch(() => {});
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

describe('CommunityApi retry policy', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('retries on 503 then succeeds, reporting each retry', async () => {
    fetchMock.mockResolvedValueOnce(status(503)).mockResolvedValueOnce(status(503)).mockResolvedValueOnce(json({ ok: true, store: 'pg' }));
    const waking: [number, number][] = [];
    const api = new CommunityApi(BASE, '', { onWaking: (a, e) => waking.push([a, e]) });
    const r = await settle(api.health(), 5_000);
    expect(r).toEqual({ ok: true, store: 'pg' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(waking.map(([a]) => a)).toEqual([1, 2]);
    expect(waking[1][1]).toBeGreaterThanOrEqual(500);
  });

  it('retries a network failure and keeps the Authorization header', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(json({ items: [], page: 1, per_page: 24, total: 0 }));
    const api = new CommunityApi(BASE, 'tok');
    const r = await settle(api.list({ kind: 'loop' }), 5_000);
    expect(r.total).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/items?kind=loop`);
  });

  it('does not retry on 400 and surfaces the server message', async () => {
    fetchMock.mockResolvedValue(json({ error: 'bad sort' }, 400));
    const api = new CommunityApi(BASE);
    const p = api.list({ sort: 'top' });
    await expect(settle(p, 10_000)).rejects.toMatchObject({ name: 'ApiError', status: 400, retriable: false, message: 'bad sort' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 500 and never shows a non-JSON body (a proxy error page) as the message', async () => {
    fetchMock.mockResolvedValue(status(500, '<html><body>Internal Server Error</body></html>'));
    const api = new CommunityApi(BASE);
    await expect(settle(api.health(), 10_000)).rejects.toMatchObject({ status: 500, retriable: false, message: 'The community server had a problem (500). Try again in a moment.' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A JSON body whose `error` is not a string is treated the same way.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json({ error: { code: 7 } }, 500));
    await expect(settle(new CommunityApi(BASE).health(), 10_000)).rejects.toMatchObject({ message: /had a problem \(500\)/ });
  });

  it('retries a POST on 503 but not on 502 (the body may already have been applied)', async () => {
    fetchMock.mockResolvedValueOnce(status(503)).mockResolvedValueOnce(json({ token: 't', user: { id: '1', handle: 'a', display_name: 'A' } }));
    const api = new CommunityApi(BASE);
    const r = await settle(api.login('a', 'password'), 5_000);
    expect(r.token).toBe('t');
    expect(api.token).toBe('t');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(status(502));
    const api2 = new CommunityApi(BASE);
    await expect(settle(api2.create({ kind: 'loop', title: 't', description: '', tags: [], payload: {} }), 10_000)).rejects.toMatchObject({ status: 502, retriable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(status(502)).mockResolvedValueOnce(json({ ok: true, store: 'mem' }));
    await expect(settle(new CommunityApi(BASE).health(), 5_000)).resolves.toEqual({ ok: true, store: 'mem' });
  });

  it('gives up once the 75 s budget is spent', async () => {
    fetchMock.mockImplementation(async () => status(503));
    const elapsed: number[] = [];
    const api = new CommunityApi(BASE, '', { onWaking: (_a, e) => elapsed.push(e) });
    const start = Date.now();
    let rejectedAt = -1;
    const p = api.health();
    p.catch(() => (rejectedAt = Date.now()));
    await vi.advanceTimersByTimeAsync(HOSTED_RETRY.budgetMs + 20_000);
    await expect(p).rejects.toBeInstanceOf(ApiError);
    await expect(p).rejects.toMatchObject({ status: 503, retriable: true });
    // Attempts at 0, 0.5, 1.5, 3.5, 7.5, 15.5 s and then every 8 s up to 71.5 s; the next (79.5 s) is over budget.
    expect(fetchMock).toHaveBeenCalledTimes(13);
    expect(elapsed).toEqual([0, 500, 1_500, 3_500, 7_500, 15_500, 23_500, 31_500, 39_500, 47_500, 55_500, 63_500]);
    // The failure lands at the last attempt, not after the budget has run out on a timer.
    expect(rejectedAt - start).toBe(71_500);
    // No retry was still pending after the rejection.
    expect(fetchMock).toHaveBeenCalledTimes(13);
  });

  it('retries 504 for a body-less request only', async () => {
    fetchMock.mockResolvedValueOnce(status(504)).mockResolvedValueOnce(json({ ok: true, store: 'pg' }));
    await expect(settle(new CommunityApi(BASE).health(), 5_000)).resolves.toEqual({ ok: true, store: 'pg' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(status(504));
    await expect(settle(new CommunityApi(BASE, 'tok').comment('id', 'hi'), 10_000)).rejects.toMatchObject({ status: 504, retriable: false, message: /had a problem \(504\)/ });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a body-less POST on 502 (share and like are idempotent on the server)', async () => {
    fetchMock.mockResolvedValueOnce(status(502)).mockResolvedValueOnce(json({ code: 'abc123', url: `${BASE}/s/abc123` }));
    const r = await settle(new CommunityApi(BASE, 'tok').share('it1'), 5_000);
    expect(r.code).toBe('abc123');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('sends Content-Type and a serialized body only when there is one, and no Authorization without a token', async () => {
    fetchMock.mockResolvedValue(json({ id: 'n' }));
    await settle(new CommunityApi(BASE + '/').create({ kind: 'preset', title: 't', description: 'd', tags: ['a'], payload: { x: 1 } }), 1_000);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/items`);
    expect(init.method).toBe('POST');
    expect(init.mode).toBe('cors');
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'preset', title: 't', description: 'd', tags: ['a'], payload: { x: 1 } });
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Accept).toBe('application/json');
    expect(headers.Authorization).toBeUndefined();
  });

  it("replaces the browser's network error wording with plain copy and keeps the original as the cause", async () => {
    const raw = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(raw);
    const api = new CommunityApi(BASE, '', { retry: { budgetMs: 100, attemptTimeoutMs: 50, baseDelayMs: 1_000, maxDelayMs: 1_000 } });
    const p = api.health();
    await expect(settle(p, 1_000)).rejects.toMatchObject({ status: 0, offline: true, message: "Couldn't reach the community server" });
    await expect(p).rejects.toHaveProperty('cause', raw);
  });

  it('treats an AbortError like a timeout and falls back to a generic message for a bare rejection', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError')).mockResolvedValueOnce(json({ ok: true, store: 'pg' }));
    await expect(settle(new CommunityApi(BASE).health(), 5_000)).resolves.toEqual({ ok: true, store: 'pg' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockRejectedValue({});
    const api = new CommunityApi(BASE, '', { retry: { budgetMs: 100, attemptTimeoutMs: 50, baseDelayMs: 1_000, maxDelayMs: 1_000 } });
    await expect(settle(api.health(), 1_000)).rejects.toMatchObject({ status: 0, offline: true, retriable: true, message: "Couldn't reach the community server" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still issues requests when AbortSignal.timeout is unavailable', async () => {
    vi.stubGlobal('AbortSignal', {});
    fetchMock.mockResolvedValue(json({ ok: true, store: 'pg' }));
    await expect(settle(new CommunityApi(BASE).health(), 1_000)).resolves.toEqual({ ok: true, store: 'pg' });
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeUndefined();
  });

  it('returns null for an empty 200 body and uses the status line when an error body is empty', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    await expect(settle(new CommunityApi(BASE).me(), 1_000)).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(new Response('', { status: 403, statusText: 'Forbidden' }));
    await expect(settle(new CommunityApi(BASE).me(), 1_000)).rejects.toMatchObject({ status: 403, retriable: false, message: 'The community server refused the request (403 Forbidden).' });
  });

  it('reports a hosted attempt as waking once it has been pending for WAKE_NOTICE_MS, before any retry', async () => {
    // Render holds the first request open while booting, so the notice must not wait for the attempt to fail.
    fetchMock.mockImplementation(() => new Promise((r) => setTimeout(() => r(json({ ok: true, store: 'pg' })), WAKE_NOTICE_MS + 1_000)));
    const waking: [number, number][] = [];
    const api = new CommunityApi(BASE, '', { onWaking: (a, e) => waking.push([a, e]) });
    const p = api.health();
    await vi.advanceTimersByTimeAsync(WAKE_NOTICE_MS - 1);
    expect(waking).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(waking).toEqual([[1, WAKE_NOTICE_MS]]);
    await expect(settle(p, 5_000)).resolves.toEqual({ ok: true, store: 'pg' });
    // A single attempt that succeeded reports once; nothing fires after the answer.
    expect(waking).toHaveLength(1);
  });

  it('does not raise the pending notice for a quick answer or for a local server', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, store: 'pg' }));
    const waking = vi.fn();
    await settle(new CommunityApi(BASE, '', { onWaking: waking }).health(), WAKE_NOTICE_MS * 2);
    expect(waking).not.toHaveBeenCalled();

    fetchMock.mockImplementation(() => new Promise((r) => setTimeout(() => r(json({ ok: true, store: 'mem' })), WAKE_NOTICE_MS + 1_000)));
    await settle(new CommunityApi('http://localhost:8787', '', { onWaking: waking }).health(), WAKE_NOTICE_MS * 2);
    expect(waking).not.toHaveBeenCalled();
  });

  it('an explicit retry policy overrides host detection', () => {
    const custom = { budgetMs: 1, attemptTimeoutMs: 1, baseDelayMs: 1, maxDelayMs: 1 };
    expect(new CommunityApi('http://localhost:8787', '', { retry: custom }).retry).toBe(custom);
    expect(new CommunityApi(BASE).retry).toBe(HOSTED_RETRY);
    expect(new CommunityApi('http://localhost:8787').retry).toBe(LOCAL_RETRY);
  });

  it('uses the short local policy for a dev server', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const api = new CommunityApi('http://localhost:8787');
    const start = Date.now();
    let rejectedAt = -1;
    const p = api.health();
    p.catch(() => (rejectedAt = Date.now()));
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).rejects.toMatchObject({ status: 0, offline: true });
    // Attempts at 0, 0.5 and 1.5 s; a fourth at 2.5 s would overrun the 2 s budget.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(rejectedAt - start).toBe(1_500);
  });

  it('returns undefined for 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const api = new CommunityApi(BASE, 'tok');
    await expect(settle(api.remove('x y'), 1_000)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/items/x%20y`);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });
});

describe('CommunityApi per-attempt timeout', () => {
  // Real timers: AbortSignal.timeout runs on Node's internal clock, which fake
  // timers cannot advance, so the policy is shrunk to milliseconds instead.
  afterEach(() => vi.unstubAllGlobals());

  it('aborts a hung attempt and retries', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(hang()).mockResolvedValueOnce(json({ ok: true, store: 'pg' }));
    vi.stubGlobal('fetch', fetchMock);
    const waking: number[] = [];
    const api = new CommunityApi(BASE, '', { retry: { budgetMs: 2_000, attemptTimeoutMs: 20, baseDelayMs: 1, maxDelayMs: 1 }, onWaking: (a) => waking.push(a) });
    await expect(api.health()).resolves.toEqual({ ok: true, store: 'pg' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(true);
    expect(waking).toEqual([1]);
  });

  it('reports a timeout as an offline ApiError when every attempt hangs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(hang()));
    const api = new CommunityApi(BASE, '', { retry: { budgetMs: 60, attemptTimeoutMs: 15, baseDelayMs: 1, maxDelayMs: 1 } });
    await expect(api.health()).rejects.toMatchObject({ status: 0, retriable: true, message: /did not answer in time/ });
  });
});

describe('CommunityApi.isLocalUrl', () => {
  it.each([
    ['http://localhost:8787', true],
    ['http://LOCALHOST', true],
    ['http://127.0.0.1:8787/', true],
    ['http://[::1]:8787', true],
    ['http://0.0.0.0:8787', true],
    ['http://dev.localhost:8787', true],
    ['http://studio.local', true],
    ['http://192.168.1.20:8787', true],
    ['http://10.0.0.5', true],
    ['http://172.16.0.1', true],
    ['http://172.31.255.1', true],
    ['http://172.32.0.1', false],
    ['https://gesture-synth-api.onrender.com', false],
    ['https://localhost.example.com', false],
    ['https://example.local.dev', false],
    ['not a url', false],
    ['', false],
  ])('%s -> %s', (url, expected) => {
    expect(CommunityApi.isLocalUrl(url)).toBe(expected);
    expect(new CommunityApi(url).local).toBe(expected);
  });
});
