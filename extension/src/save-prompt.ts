/** Entry point of save-prompt.html: the iframe the save-watch script puts on the page (?id=<candidate id>). */
import { promptView } from "./save/prompt-view.ts";
import type { SaveAnswerMessage, SaveAnswerResponse, SaveInfoMessage, SavePromptInfo } from "./save/messages.ts";

async function start() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) return;
  const infoMessage: SaveInfoMessage = { target: "background", type: "save-info", candidateId: id };
  const info = (await chrome.runtime.sendMessage(infoMessage)) as SavePromptInfo | undefined;
  if (!info) return;
  document.getElementById("app")!.replaceChildren(
    promptView(info, {
      answer: async (answer) => {
        const message: SaveAnswerMessage = { target: "background", type: "save-answer", candidateId: info.id, answer };
        return (await chrome.runtime.sendMessage(message)) as SaveAnswerResponse;
      },
      unlock: () => void chrome.action.openPopup().catch(() => undefined),
      // The service worker removes the frame itself (2 s after a save).
      done: () => undefined,
    }),
  );
}

void start();
