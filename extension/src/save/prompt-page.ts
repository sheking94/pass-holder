/** The panel page (save-prompt.html?id=<candidate id>) without the chrome.* wiring, so it can be tested. */
import { promptView } from "./prompt-view.ts";
import type { SaveAnswerMessage, SaveAnswerResponse, SaveInfoMessage, SavePromptInfo } from "./messages.ts";

export interface PromptPageRuntime {
  send(m: SaveInfoMessage | SaveAnswerMessage): Promise<unknown>;
  openPopup(): Promise<void>;
}

export async function startPromptPage(app: HTMLElement, id: string | null, runtime: PromptPageRuntime): Promise<void> {
  if (!id) return;
  const answerMessage = (answer: SaveAnswerMessage["answer"]): SaveAnswerMessage =>
    ({ target: "background", type: "save-answer", candidateId: id, answer });
  const info = async () =>
    (await runtime.send({ target: "background", type: "save-info", candidateId: id })) as SavePromptInfo | undefined;

  const render = (current: SavePromptInfo) => {
    app.replaceChildren(promptView(current, {
      answer: async (answer) => {
        const result = (await runtime.send(answerMessage(answer))) as SaveAnswerResponse;
        // The vault may have locked after the panel loaded: show "Odblokuj i zapisz" instead of the error.
        if (!result.ok && answer === "save") {
          const fresh = await info().catch(() => undefined);
          if (fresh?.locked) render(fresh);
          else if (!fresh) await dismiss();
        }
        return result;
      },
      unlock: () => void runtime.openPopup().catch(() => undefined),
      // The service worker removes the frame itself (2 s after a save).
      done: () => undefined,
    }));
  };
  // Nothing to ask about (expired, or the login is already saved): ask the service worker to take the frame away.
  const dismiss = () => runtime.send(answerMessage("later")).then(() => undefined, () => undefined);

  const first = await info().catch(() => undefined);
  if (first) render(first);
  else await dismiss();
}
