/** Registers every view of popup.html in the router; the only module that imports them all. */
import { openAddresses } from "./addresses.ts";
import { showConnect } from "./connect.ts";
import { editView } from "./edit.ts";
import { listView } from "./list.ts";
import { showLocked, showUnlocked } from "./locked.ts";
import { pinSettingsView } from "./pin-settings.ts";
import { registerViews } from "./router.ts";
import { saveQuestionView } from "./save-question.ts";
import { saveSettingsView } from "./save-settings.ts";
import { openTransfer } from "./transfer.ts";

registerViews({
  list: listView,
  edit: editView,
  locked: showLocked,
  unlocked: showUnlocked,
  connect: showConnect,
  addresses: openAddresses,
  transfer: openTransfer,
  pinSettings: pinSettingsView,
  saveSettings: saveSettingsView,
  saveQuestion: saveQuestionView,
});
