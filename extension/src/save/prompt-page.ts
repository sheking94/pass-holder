import type { ActionResult } from "../result.ts";
/** The question window's page (save-prompt.html?id=<candidate id>) without the chrome.* wiring, so it can be tested. */
import { promptView } from "./prompt-view.ts";
import {
  saveAnswerMessage,
  savePreviewMessage,
  type SaveAnswerMessage,
  type SaveInfoMessage,
  type SavePreviewMessage,
  type SavePreviewResponse,
  type SavePromptInfo,
  type SaveUnlockMessage,
} from "./messages.ts";

export interface PromptPageRuntime {
  send(
    m: SaveInfoMessage | SaveAnswerMessage | SavePreviewMessage | SaveUnlockMessage,
  ): Promise<unknown>;
  /** Closes the window itself, when nothing is left to ask. */
  close(): void;
}

export async function startPromptPage(
  app: HTMLElement,
  id: string | null,
  runtime: PromptPageRuntime,
): Promise<void> {
  if (!id) return runtime.close();
  const info = async () =>
    (await runtime.send({ target: "background", type: "save-info", candidateId: id })) as
      SavePromptInfo | undefined;

  const render = (current: SavePromptInfo) => {
    app.replaceChildren(
      promptView(current, {
        preview: async (username, password) =>
          (await runtime.send(savePreviewMessage(id, username, password))) as SavePreviewResponse,
        answer: async (answer, draft) => {
          const result = (await runtime.send(saveAnswerMessage(id, answer, draft))) as ActionResult;
          // The vault may have locked after the panel loaded: show "Odblokuj i zapisz" instead of the error.
          if (!result.ok && answer === "save") {
            const fresh = await info().catch(() => undefined);
            if (fresh?.locked) render(fresh);
            else if (!fresh) await dismiss();
          }
          return result;
        },
        unlock: () =>
          void runtime
            .send({ target: "background", type: "save-unlock", candidateId: id })
            .catch(() => undefined),
        // The service worker closes the window itself (2 s after a save).
        done: () => undefined,
      }),
    );
  };
  // Nothing to ask about (expired, or the login is already saved): drop the candidate and close the window.
  const dismiss = () =>
    runtime
      .send(saveAnswerMessage(id, "later"))
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => runtime.close());

  const first = await info().catch(() => undefined);
  if (first) render(first);
  else await dismiss();
}
