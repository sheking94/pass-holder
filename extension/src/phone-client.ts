import { p2p } from "@passholder/core";
import { PHONE_UNREACHABLE } from "./error-messages.ts";

export { PHONE_UNREACHABLE } from "./error-messages.ts";

/** The phone did not answer: a network failure, a timeout, or no address answered. The message is for the user. */
export class PhoneUnreachableError extends Error {
  override readonly name = "PhoneUnreachableError";
}

/**
 * How long one request may take, answer body included, unless a shorter timeout is given (the probe).
 * Generous: the phone may be slow, but a request must not hang forever on a dropped Wi-Fi.
 */
export const POST_TIMEOUT_MS = 30_000;

/**
 * HTTP client for the phone in sync mode (docs/SYNCHRONIZACJA.md). Every call is a JSON POST; `post` is the
 * FetchJson the pairing client and noiseTransport take. A network failure or a timeout (POST_TIMEOUT_MS) becomes
 * PhoneUnreachableError; an HTTP error status is returned as is, for callP2pHost to turn into an error.
 */
export class PhoneClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch.bind(globalThis),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  readonly post: p2p.FetchJson = (url, body) => this.request(url, body, POST_TIMEOUT_MS);

  /** Pings the phone. With timeoutMs, gives up (PhoneUnreachableError) when it has not answered in time. */
  status(timeoutMs = POST_TIMEOUT_MS): Promise<void> {
    return p2p.pingPhone(this.baseUrl, (url, body) => this.request(url, body, timeoutMs));
  }

  private async request(
    url: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A plain setTimeout (not AbortSignal.timeout) so a fetch or a body that ignores the signal still gives up.
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PhoneUnreachableError(PHONE_UNREACHABLE));
      }, timeoutMs);
    });
    const exchange = async () => {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).catch(() => {
        throw new PhoneUnreachableError(PHONE_UNREACHABLE);
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    try {
      return await Promise.race([exchange(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}
