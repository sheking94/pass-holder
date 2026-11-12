import { loginScope, emptyLoginForms, readLogin } from "./read-form.ts";
import type { SaveCandidateMessage, SavePendingMessage, ToWatchMessage } from "./messages.ts";

export interface WatchRuntime {
  send(m: SaveCandidateMessage | SavePendingMessage): Promise<unknown>;
  onMessage(h: (m: ToWatchMessage) => void): void;
  panelUrl(candidateId: string): string;
}

type FrameRole = "top" | "subframe";

/** "top" for the top frame, "subframe" when same-origin with top, undefined when top is cross-origin. */
function frameRole(doc: Document): FrameRole | undefined {
  const win = doc.defaultView;
  if (!win) return undefined;
  try {
    const top = win.top;
    if (top === win) return "top";
    return top?.location.origin === win.location.origin ? "subframe" : undefined;
  } catch {
    return undefined;
  }
}

const CLICKABLE = "button, input[type=submit], [role=button]";

export function startSaveWatch(doc: Document, runtime: WatchRuntime): void {
  const role = frameRole(doc);
  if (!role) return;

  const report = (scope: ParentNode | undefined): void => {
    if (!scope) return;
    const login = readLogin(scope);
    if (!login) return;
    void runtime.send({ target: "background", type: "save-candidate", ...login }).catch(() => {});
  };

  // Capture phase on the document: runs before page handlers that may clear the fields.
  doc.addEventListener("submit", (e) => {
    if (e.target instanceof Element) report(loginScope(e.target));
  }, true);
  doc.addEventListener("keydown", (e) => {
    const t = e.target;
    if (e.key === "Enter" && t instanceof HTMLInputElement && t.type === "password") report(loginScope(t));
  }, true);
  doc.addEventListener("click", (e) => {
    const t = e.target;
    const button = t instanceof Element ? t.closest(CLICKABLE) : null;
    if (button) report(loginScope(button));
  }, true);

  if (role !== "top") return;

  let host: HTMLElement | undefined;
  let frame: HTMLIFrameElement | undefined;
  let shown: string | undefined;
  const hide = (): void => { host?.remove(); host = frame = shown = undefined; };
  const show = (candidateId: string): void => {
    const src = runtime.panelUrl(candidateId);
    if (host?.isConnected && frame) {
      // A newer candidate (another login on the same page): the panel must ask about that one.
      if (shown !== src) frame.src = shown = src;
      return;
    }
    host = doc.createElement("div");
    host.setAttribute("data-passholder-save", "");
    host.style.cssText = "position: fixed; top: 16px; right: 16px; z-index: 2147483647;";
    frame = doc.createElement("iframe");
    frame.src = shown = src;
    frame.style.cssText = "width: 360px; height: 340px; border: 0; display: block;";
    host.attachShadow({ mode: "closed" }).append(frame);
    (doc.body ?? doc.documentElement).append(host);
  };

  runtime.onMessage((m) => {
    if (m.type === "save-show") show(m.candidateId);
    else if (m.type === "save-hide") hide();
  });

  void runtime.send({ target: "background", type: "save-pending", emptyLoginForms: emptyLoginForms(doc) })
    .then((reply) => {
      const id = (reply as { candidateId?: unknown } | undefined)?.candidateId;
      if (typeof id === "string") show(id);
    })
    .catch(() => {});
}
