// The answer shape of the reference P2P host (p2p/host.ts, files/host-files.ts).

/** An answer of the host: HTTP status and JSON body. */
export interface HostReply {
  status: number;
  body: unknown;
}

/** An error answer: `{ error }` with this status. */
export function errorReply(status: number, error: string): HostReply {
  return { status, body: { error } };
}
