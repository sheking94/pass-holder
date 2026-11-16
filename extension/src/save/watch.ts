import { loginScope, emptyLoginForms, readLogin } from "./read-form.ts";
import type { SaveCandidateMessage, SavePendingMessage } from "./messages.ts";

export interface WatchRuntime {
  send(m: SaveCandidateMessage | SavePendingMessage): Promise<unknown>;
  /**
   * Whether the event came from the user (default: `userEvent`). A page script can dispatch submit, click and
   * keydown itself, and must not be able to make up a candidate (review V3-S1, V3-N3). Tests override it,
   * because every event dispatched there is untrusted.
   */
  trusted?(e: Event): boolean;
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

/**
 * The user's own action. isTrusted alone is not enough for submit: Chrome fires a trusted submit also for a
 * script's form.requestSubmit() or button.click(), so a submit needs a recent click or key press on the page too
 * (transient user activation, a few seconds).
 */
function userEvent(e: Event, doc: Document): boolean {
  if (e.isTrusted !== true) return false;
  if (e.type !== "submit") return true;
  const activation = (
    doc.defaultView?.navigator as { userActivation?: { isActive: boolean } } | undefined
  )?.userActivation;
  return activation?.isActive === true;
}

/**
 * Reports submitted logins to the service worker. The question itself is not on the page: the service worker
 * shows it in its own window (prompt-window.ts), which the page can neither see nor cover.
 */
export function startSaveWatch(doc: Document, runtime: WatchRuntime): void {
  const role = frameRole(doc);
  if (!role) return;
  const trusted = runtime.trusted ?? ((e: Event) => userEvent(e, doc));

  const report = (scope: ParentNode | undefined): void => {
    if (!scope) return;
    const login = readLogin(scope);
    if (!login) return;
    void runtime.send({ target: "background", type: "save-candidate", ...login }).catch(() => {});
  };

  // Capture phase on the document: runs before page handlers that may clear the fields.
  doc.addEventListener(
    "submit",
    (e) => {
      if (trusted(e) && e.target instanceof Element) report(loginScope(e.target));
    },
    true,
  );
  doc.addEventListener(
    "keydown",
    (e) => {
      const t = e.target;
      if (trusted(e) && e.key === "Enter" && t instanceof HTMLInputElement && t.type === "password")
        report(loginScope(t));
    },
    true,
  );
  doc.addEventListener(
    "click",
    (e) => {
      const t = e.target;
      const button = trusted(e) && t instanceof Element ? t.closest(CLICKABLE) : null;
      if (button) report(loginScope(button));
    },
    true,
  );

  // A new page in the tab: the service worker shows the window again, or closes it after a failed login.
  if (role === "top") {
    void runtime
      .send({ target: "background", type: "save-pending", emptyLoginForms: emptyLoginForms(doc) })
      .catch(() => {});
  }
}
