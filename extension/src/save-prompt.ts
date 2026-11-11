/** Entry point of save-prompt.html: the iframe the save-watch script puts on the page (?id=<candidate id>). */
import { startPromptPage } from "./save/prompt-page.ts";

void startPromptPage(document.getElementById("app")!, new URLSearchParams(location.search).get("id"), {
  send: (m) => chrome.runtime.sendMessage(m),
  openPopup: () => chrome.action.openPopup(),
});
