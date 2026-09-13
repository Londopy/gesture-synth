import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The stores are Svelte rune modules that touch localStorage on load; the
// client only reads two fields and calls one method, so they are stubbed.
const { store, toast } = vi.hoisted(() => ({
  store: { s: { communityUrl: 'https://gesture-synth-api.onrender.com', communityToken: '' } },
  toast: vi.fn(),
}));
vi.mock('../state/settings.svelte', () => ({ settings: store }));
vi.mock('../state/ui.svelte', () => ({ ui: { toast } }));

import { WAKING_TEXT, communityApi, prewarmCommunity, wakeToaster } from './client';
import { HOSTED_RETRY } from './api';

describe('wakeToaster', () => {
  beforeEach(() => {
    toast.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('toasts once when a wait starts, then at most every 20 s of wall-clock time', () => {
    const w = wakeToaster();
    // The pending notice at 2 s, then the backoff call after the 20 s timeout: same wait, one toast.
    w(1, 2_000);
    vi.advanceTimersByTime(18_000);
    w(1, 20_000);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenLastCalledWith(WAKING_TEXT, 'info', 12_000);
    vi.advanceTimersByTime(1_999);
    w(2, 21_999);
    expect(toast).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    w(2, 22_000);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast.mock.calls[1][0]).toMatch(/still waking/i);
    vi.advanceTimersByTime(19_999);
    w(4, 41_999);
    expect(toast).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    w(4, 42_000);
    expect(toast).toHaveBeenCalledTimes(3);
  });

  it('announces a fresh wait on a shared client even though its elapsed time starts over', () => {
    const w = wakeToaster();
    w(1, 2_000);
    vi.advanceTimersByTime(60 * 60_000);
    w(1, 2_000);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenLastCalledWith(WAKING_TEXT, 'info', 12_000);
  });

  it('each toaster tracks its own throttle window', () => {
    wakeToaster()(1, 0);
    wakeToaster()(1, 0);
    expect(toast).toHaveBeenCalledTimes(2);
  });
});

describe('communityApi', () => {
  it('builds the client from settings with the hosted policy and the toaster by default', () => {
    store.s.communityUrl = 'https://gesture-synth-api.onrender.com/';
    store.s.communityToken = 'tok';
    const api = communityApi();
    expect(api.baseUrl).toBe('https://gesture-synth-api.onrender.com/');
    expect(api.token).toBe('tok');
    expect(api.retry).toBe(HOSTED_RETRY);
    expect(typeof api.onWaking).toBe('function');
    const custom = vi.fn();
    expect(communityApi(custom).onWaking).toBe(custom);
  });
});

describe('prewarmCommunity', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let run = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    store.s.communityUrl = 'https://gesture-synth-api.onrender.com/';
    // The throttle is module state shared by every test here, so each test
    // starts its clock well past anything an earlier one could have recorded.
    vi.setSystemTime(Date.now() + 600_000 * ++run);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fires one GET /health and throttles to once a minute', () => {
    prewarmCommunity();
    prewarmCommunity();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gesture-synth-api.onrender.com/health');
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');
    expect(init.mode).toBe('cors');
    vi.advanceTimersByTime(59_999);
    prewarmCommunity();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    prewarmCommunity();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skips local dev servers and an empty URL', () => {
    store.s.communityUrl = 'http://localhost:8787';
    prewarmCommunity();
    store.s.communityUrl = '';
    prewarmCommunity();
    expect(fetchMock).not.toHaveBeenCalled();
    // Positive control: the same clock position does fire for a hosted URL, so
    // the silence above came from the URL checks and not from the throttle.
    store.s.communityUrl = 'https://gesture-synth-api.onrender.com';
    prewarmCommunity();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('swallows a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(() => prewarmCommunity()).not.toThrow();
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
