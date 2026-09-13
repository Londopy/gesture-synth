// Client for the Gleam community service (services/community). All JSON.

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

export class CommunityApi {
  constructor(
    public baseUrl: string,
    public token: string = '',
  ) {}

  private async req<T>(method: string, path: string, body?: any): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(this.baseUrl.replace(/\/$/, '') + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      mode: 'cors',
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }
    if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
    return data as T;
  }

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
}
