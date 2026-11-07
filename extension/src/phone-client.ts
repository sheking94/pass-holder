import { p2p } from "@passholder/core";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const PHONE_UNREACHABLE = "Telefon nie odpowiada. Czy tryb Synchronizacja jest włączony?";

/**
 * HTTP client for the phone in sync mode (docs/SYNCHRONIZACJA_P2P.md). Every call is a JSON POST; `post` is the
 * FetchJson the pairing client and noiseTransport take. A network failure becomes ApiError(0, PHONE_UNREACHABLE);
 * an HTTP error status is returned as is, for callP2pHost to turn into a message.
 */
export class PhoneClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch.bind(globalThis),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  readonly post: p2p.FetchJson = (url, body) => this.request(url, body);

  /** Pings the phone. With timeoutMs, gives up (as unreachable, status 0) when it has not answered in time. */
  status(timeoutMs?: number): Promise<void> {
    return p2p.pingPhone(this.baseUrl, (url, body) => this.request(url, body, timeoutMs));
  }

  private async request(url: string, body: unknown, timeoutMs?: number): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A plain setTimeout (not AbortSignal.timeout) so a fetch that ignores the signal still gives up.
    const timedOut = new Promise<never>((_, reject) => {
      if (timeoutMs === undefined) return;
      timer = setTimeout(() => {
        controller.abort();
        reject(new ApiError(0, PHONE_UNREACHABLE));
      }, timeoutMs);
    });
    try {
      const res = await Promise.race([
        this.fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        timedOut,
      ]).catch((error: unknown) => {
        throw error instanceof ApiError ? error : new ApiError(0, PHONE_UNREACHABLE);
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
      clearTimeout(timer);
    }
  }
}
