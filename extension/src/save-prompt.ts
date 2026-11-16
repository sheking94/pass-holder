/** Entry point of save-prompt.html: the question window the service worker opens (?id=<candidate id>). */
import { startPromptPage } from "./save/prompt-page.ts";

void startPromptPage(
  document.getElementById("app")!,
  new URLSearchParams(location.search).get("id"),
  {
    send: (m) => chrome.runtime.sendMessage(m),
    close: () => window.close(),
  },
);
