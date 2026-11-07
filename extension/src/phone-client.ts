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
export const PHONE_FORGOT_BROWSER = "Telefon nie zna tej przeglądarki. Sparuj ponownie.";
export const PHONE_MALFORMED = "Telefon odpowiedział niepoprawnie.";

/**
 * How long one request may take, answer body included, unless a shorter timeout is given (the probe).
 * Generous: the phone may be slow, but a request must not hang forever on a dropped Wi-Fi.
 */
export const POST_TIMEOUT_MS = 30_000;

/**
 * The core's English errors from the phone, in Polish. Messages that are already Polish (pairing, addresses,
 * unreachable) pass through unchanged.
 */
export function phoneErrorInPolish(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof ApiError) return error;
  const message = error.message;
  if (message === "P2P host returned 403: device not paired") return new Error(PHONE_FORGOT_BROWSER);
  // A bad shape, or a Noise message that does not open: either way the answer is not what a PassHolder phone sends.
  if (message === "P2P host returned a malformed response" || message.startsWith("Noise:")) return new Error(PHONE_MALFORMED);
  const status = /^P2P host returned (\d+): (.*)$/.exec(message);
  if (status) return new Error(`Telefon odpowiedział błędem ${status[1]} (${status[2]}).`);
  return error;
}

/**
 * HTTP client for the phone in sync mode (docs/SYNCHRONIZACJA_P2P.md). Every call is a JSON POST; `post` is the
 * FetchJson the pairing client and noiseTransport take. A network failure or a timeout (POST_TIMEOUT_MS) becomes
 * ApiError(0, PHONE_UNREACHABLE); an HTTP error status is returned as is, for callP2pHost to turn into a message.
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

  /** Pings the phone. With timeoutMs, gives up (as unreachable, status 0) when it has not answered in time. */
  status(timeoutMs = POST_TIMEOUT_MS): Promise<void> {
    return p2p.pingPhone(this.baseUrl, (url, body) => this.request(url, body, timeoutMs));
  }

  private async request(url: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A plain setTimeout (not AbortSignal.timeout) so a fetch or a body that ignores the signal still gives up.
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ApiError(0, PHONE_UNREACHABLE));
      }, timeoutMs);
    });
    const exchange = async () => {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).catch(() => {
        throw new ApiError(0, PHONE_UNREACHABLE);
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
