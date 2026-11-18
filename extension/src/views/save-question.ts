import type { ActionResult } from "../result.ts";
import {
  saveAnswerMessage,
  savePreviewMessage,
  type SavePreviewResponse,
  type SavePromptInfo,
} from "../save/messages.ts";
import { promptView } from "../save/prompt-view.ts";
import { show } from "../ui/dom.ts";
import { views } from "./router.ts";

/** The save question over the list, after unlocking from a tab with a pending candidate. */
export function saveQuestionView(info: SavePromptInfo): void {
  show(
    promptView(info, {
      preview: async (username, password) =>
        (await chrome.runtime.sendMessage(
          savePreviewMessage(info.id, username, password),
        )) as SavePreviewResponse,
      answer: async (answer, draft) => {
        const result = (await chrome.runtime.sendMessage(
          saveAnswerMessage(info.id, answer, draft),
        )) as ActionResult;
        if (result.ok && answer !== "save") views().list();
        return result;
      },
      // Already unlocked here; a locked candidate cannot reach this view.
      unlock: () => undefined,
      done: () => views().list({ message: "Zapisano login." }),
    }),
  );
}
