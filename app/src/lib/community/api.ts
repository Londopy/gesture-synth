// Client for the Gleam community service (services/community). All JSON.
//
// The hosted service runs on Render's free tier, which spins the instance down
// after 15 idle minutes and then holds the first request open (or fails it at
// the network level) for 20-90 s while it boots. Every request therefore goes
// through a retry loop tuned so a cold start fits inside one logical call.

export type ItemKind = 'song' | 'tutorial' | 'preset' | 'theme' | 'loop';

export interface User {
  id: string;
  handle: string;
  display_name: string;
}

export interface Item {
  id: string;
  kind: ItemKind;
  title: string;
  description: string;
  author_id: string;
  author?: User;
  tags: string[];
  payload?: any;
  parent_id: string | null;
  parent?: { id: string; title: string } | null;
  like_count: number;
  comment_count: number;
  created_at: string;
  updated_at: string;
  liked?: boolean;
}

export interface Comment {
  id: string;
  item_id: string;
  author_id: string;
  author?: User;
  body: string;
  created_at: string;
}

export interface ListResult {
  items: Item[];
  page: number;
  per_page: number;
  total: number;
}

/**
 * Error from the community client. `status` is the HTTP status the server
 * answered with, or 0 when no response arrived at all (DNS, refused
 * connection, a CORS-less proxy error page, per-attempt timeout). Callers use
 * that split to tell "the server is down or asleep" from "the server said no".
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retriable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ApiError';
  }

  /** No HTTP response was received; the server may be asleep or unreachable. */
  get offline() {
    return this.status === 0;
  }
}

export interface RetryPolicy {
  /** Wall-clock budget for one logical request, retries included. */
  budgetMs: number;
  /** Per-attempt cap; a connection the proxy is holding past this is aborted and retried. */
  attemptTimeoutMs: number;
  /** First backoff delay; doubles per retry up to maxDelayMs. */
  baseDelayMs: number;
  maxDelayMs: number;
}

/** 0.5, 1, 2, 4, 8, 8, 8... s between attempts, 13 attempts in 75 s; a ~50 s Render wake fits. */
export const HOSTED_RETRY: RetryPolicy = { budgetMs: 75_000, attemptTimeoutMs: 20_000, baseDelayMs: 500, maxDelayMs: 8_000 };
/** A dev server either runs or it does not, so give up after a couple of quick tries. */
export const LOCAL_RETRY: RetryPolicy = { budgetMs: 2_000, attemptTimeoutMs: 5_000, baseDelayMs: 500, maxDelayMs: 1_000 };

/**
 * How long a hosted attempt may sit unanswered before onWaking fires for it.
 * Render holds a JSON request open while the app boots rather than failing it,
 * so without this the first sign of life would be the 20 s per-attempt timeout.
 */
export const WAKE_NOTICE_MS = 2_000;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export class CommunityApi {
  /**
   * Called once a hosted attempt has been pending for WAKE_NOTICE_MS and again
   * before each retry, so the UI can say the server is waking instead of
   * looking frozen. May fire more than once per attempt; handlers throttle.
   */
  onWaking?: (attempt: number, elapsedMs: number) => void;
  retry: RetryPolicy;

  constructor(
    public baseUrl: string,
    public token: string = '',
    opts: { onWaking?: (attempt: number, elapsedMs: number) => void; retry?: RetryPolicy } = {},
  ) {
    this.onWaking = opts.onWaking;
    this.retry = opts.retry ?? (CommunityApi.isLocalUrl(baseUrl) ? LOCAL_RETRY : HOSTED_RETRY);
  }

  /** Loopback, *.localhost, *.local and RFC 1918 addresses: a dev server that never sleeps. */
  static isLocalUrl(url: string): boolean {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (LOCAL_HOSTS.has(host)) return true;
    if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  }

  get local() {
    return CommunityApi.isLocalUrl(this.baseUrl);
  }

  private async req<T>(method: string, path: string, body?: any): Promise<T> {
    // Accept must not mention text/html: Render answers HTML-accepting clients
    // with an un-CORS'd 503 interstitial that the browser hides behind a
    // TypeError, whereas */json requests are held until the app is up.
    const headers: Record<string, string> = { Accept: 'application/json' };
    const hasBody = body !== undefined;
    if (hasBody) headers['Content-Type'] = 'application/json';
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const url = this.baseUrl.replace(/\/$/, '') + path;
    const payload = hasBody ? JSON.stringify(body) : undefined;
    const started = Date.now();
    const local = this.local;

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      // A dev server answers or refuses at once, so a slow attempt there is not a wake.
      const notice = local ? undefined : setTimeout(() => this.onWaking?.(attempt, Date.now() - started), WAKE_NOTICE_MS);
      try {
        res = await fetch(url, { method, headers, body: payload, mode: 'cors', signal: attemptSignal(this.retry.attemptTimeoutMs) });
      } catch (e) {
        clearTimeout(notice);
        // Nothing came back, so the server never answered this attempt. Retrying
        // is safe for reads, and for register/login/publish too: register and
        // login are idempotent from the user's side (a duplicate register is
        // refused with "handle taken" and the user simply signs in), and the
        // publish flows wake the server with GET /health first so their create
        // runs against an awake instance. Residual risk: a request aborted by
        // the per-attempt timeout may still be sitting in the proxy's buffer and
        // be delivered once the app boots, which is why mutation callers must
        // warm up before creating anything.
        const err = networkError(e);
        if (!(await this.backoff(attempt, started))) throw err;
        continue;
      }
      clearTimeout(notice);
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // Not the service (it always answers JSON): a proxy error page whose
        // markup must not end up in a toast.
        data = null;
      }
      if (res.ok) return data as T;
      // The server (or its proxy) answered. 4xx and 500 prove the app is up and
      // will give the same answer again, so they are never retried. 502/504 mean
      // the proxy lost the upstream mid-request; a request with a body may
      // already have been applied, so only body-less requests retry on those.
      // 503 is "not processed" by definition and is retried for everything.
      const retriable = res.status === 503 || (!hasBody && (res.status === 502 || res.status === 504));
      const err = new ApiError(typeof data?.error === 'string' ? data.error : statusMessage(res), res.status, retriable);
      if (!retriable || !(await this.backoff(attempt, started))) throw err;
    }
  }

  /** Waits out the next backoff step; false when the budget would be exceeded. */
  private async backoff(attempt: number, started: number): Promise<boolean> {
    const elapsed = Date.now() - started;
    const wait = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
    if (elapsed + wait >= this.retry.budgetMs) return false;
    this.onWaking?.(attempt, elapsed);
    await new Promise((r) => setTimeout(r, wait));
    return true;
  }

  /** Cheap idempotent probe; also the call to make before any mutation against a possibly sleeping server. */
  health() {
    return this.req<{ ok: boolean; store: string }>('GET', '/health');
  }

  async register(handle: string, display_name: string, password: string) {
    const r = await this.req<{ token: string; user: User }>('POST', '/auth/register', { handle, display_name, password });
    this.token = r.token;
    return r;
  }

  async login(handle: string, password: string) {
    const r = await this.req<{ token: string; user: User }>('POST', '/auth/login', { handle, password });
    this.token = r.token;
    return r;
  }

  async logout() {
    try {
      await this.req<void>('POST', '/auth/logout');
    } finally {
      this.token = '';
    }
  }

  me() {
    return this.req<User>('GET', '/me');
  }

  list(q: { kind?: ItemKind; q?: string; tag?: string; author?: string; sort?: 'new' | 'top'; page?: number; per_page?: number } = {}) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
    return this.req<ListResult>('GET', '/items' + (p.size ? `?${p}` : ''));
  }

  get(id: string) {
    return this.req<Item>('GET', `/items/${encodeURIComponent(id)}`);
  }

  create(item: { kind: ItemKind; title: string; description: string; tags: string[]; payload: any; parent_id?: string }) {
    return this.req<Item>('POST', '/items', item);
  }

  update(id: string, patch: Partial<Pick<Item, 'title' | 'description' | 'tags' | 'payload'>>) {
    return this.req<Item>('PATCH', `/items/${encodeURIComponent(id)}`, patch);
  }

  remove(id: string) {
    return this.req<void>('DELETE', `/items/${encodeURIComponent(id)}`);
  }

  remixes(id: string) {
    return this.req<{ items: Item[] }>('GET', `/items/${encodeURIComponent(id)}/remixes`);
  }

  chain(id: string) {
    return this.req<{ chain: Item[] }>('GET', `/items/${encodeURIComponent(id)}/chain`);
  }

  like(id: string, on: boolean) {
    return this.req<{ liked: boolean; like_count: number }>(on ? 'POST' : 'DELETE', `/items/${encodeURIComponent(id)}/like`);
  }

  comments(id: string) {
    return this.req<{ comments: Comment[] }>('GET', `/items/${encodeURIComponent(id)}/comments`);
  }

  comment(id: string, body: string) {
    return this.req<Comment>('POST', `/items/${encodeURIComponent(id)}/comments`, { body });
  }

  deleteComment(id: string) {
    return this.req<void>('DELETE', `/comments/${encodeURIComponent(id)}`);
  }

  share(id: string) {
    return this.req<{ code: string; url: string }>('POST', `/items/${encodeURIComponent(id)}/share`);
  }

  /** Stage board for a song: each player's best set, highest first. */
  scores(songId: string, limit = 10) {
    return this.req<{ scores: BoardEntry[] }>('GET', `/scores?song=${encodeURIComponent(songId)}&limit=${limit}`);
  }

  /** Post a finished set (signed in; rehearsal sets are refused by the server). */
  postScore(body: { song_id: string; score: number; accuracy: number; run: number; rating: string; variations: string[] }) {
    return this.req<BoardEntry>('POST', '/scores', body);
  }
}

export interface BoardEntry {
  id: string;
  user_id: string;
  song_id: string;
  score: number;
  accuracy: number;
  run: number;
  rating: string;
  variations: string[];
  created_at: string;
  author?: User;
}

function attemptSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

/** Plain copy for an answer without a usable server message; the raw status is kept for support. */
function statusMessage(res: Response): string {
  const code = res.statusText ? `${res.status} ${res.statusText}` : String(res.status);
  return res.status >= 500 ? `The community server had a problem (${code}). Try again in a moment.` : `The community server refused the request (${code}).`;
}

/**
 * Browsers describe every no-response failure with their own wording ("Failed
 * to fetch", "Load failed", "NetworkError when attempting to fetch resource."),
 * which is what most callers toast verbatim, so it is replaced with plain copy
 * and kept as the cause.
 */
function networkError(e: unknown): ApiError {
  const name = (e as { name?: string } | null)?.name;
  const message = name === 'TimeoutError' || name === 'AbortError' ? 'The community server did not answer in time' : "Couldn't reach the community server";
  return new ApiError(message, 0, true, { cause: e });
}
