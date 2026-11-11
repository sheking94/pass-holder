import { promptView } from "../save/prompt-view.ts";
import type { SaveAnswerMessage, SaveAnswerResponse, SavePromptInfo } from "../save/messages.ts";
import { show } from "../ui/dom.ts";
import { listView } from "./list.ts";

/** The save question over the list, after unlocking from a tab with a pending candidate. */
export function saveQuestionView(info: SavePromptInfo): void {
  show(
    promptView(info, {
      answer: async (answer) => {
        const message: SaveAnswerMessage = { target: "background", type: "save-answer", candidateId: info.id, answer };
        const result = (await chrome.runtime.sendMessage(message)) as SaveAnswerResponse;
        if (result.ok && answer !== "save") listView();
        return result;
      },
      // Already unlocked here; a locked candidate cannot reach this view.
      unlock: () => undefined,
      done: () => listView("Zapisano login."),
    }),
  );
}
