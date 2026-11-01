import type { KdfParams, SyncRequest, SyncResponse } from "@passholder/core";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SessionResponse {
  token: string;
  expiresAt: number;
  wrappedVaultKey: string;
}

/** Optional parts of a request, by name, so a call never needs `undefined, undefined, …` placeholders. */
interface RequestOptions {
  /** Sent as JSON. */
  body?: unknown;
  /** Session token, sent as "Authorization: Bearer". */
  token?: string;
  /** Gives up (as "unreachable", status 0) when the server has not answered in time. */
  timeoutMs?: number;
}

/** HTTP client for the Raspberry Pi server (API in docs/SPEC.md §6). */
export class ServerClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch.bind(globalThis),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const { body, token, timeoutMs } = options;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
    } catch {
      throw new ApiError(0, "Serwer jest niedostępny. Czy Raspberry Pi jest włączone?");
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
    return data as T;
  }

  /** With timeoutMs, gives up (as "unreachable", status 0) when the server has not answered in time. */
  status(timeoutMs?: number) {
    return this.request<{ initialized: boolean; version: string }>("GET", "/api/v1/status", { timeoutMs });
  }

  setup(body: { setupToken: string; kdf: KdfParams; authKey: string; wrappedVaultKey: string }) {
    return this.request<object>("POST", "/api/v1/setup", { body });
  }

  prelogin() {
    return this.request<{ kdf: KdfParams }>("GET", "/api/v1/prelogin");
  }

  session(authKey: string) {
    return this.request<SessionResponse>("POST", "/api/v1/session", { body: { authKey } });
  }

  sync(token: string, body: SyncRequest) {
    return this.request<SyncResponse>("POST", "/api/v1/sync", { body, token });
  }
}
