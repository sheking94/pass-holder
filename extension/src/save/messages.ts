export type SaveCandidateMessage = {
  target: "background";
  type: "save-candidate";
  username: string;
  password: string;
  formSignature: string;
};

/** Sent by the top frame on every new page; the service worker shows the question window again or closes it. */
export type SavePendingMessage = {
  target: "background";
  type: "save-pending";
  emptyLoginForms: string[];
};
export type SavePendingResponse = { candidateId?: string };

/** "Odblokuj i zapisz" in the question window: bring the candidate's tab forward and open the popup over it. */
export type SaveUnlockMessage = { target: "background"; type: "save-unlock"; candidateId: string };

export type SaveInfoMessage = {
  target: "background";
  type: "save-info";
  candidateId?: string;
  tabId?: number;
};

export interface SavePromptInfo {
  id: string;
  host: string;
  username: string;
  /** Empty when locked: the password reaches extension pages only once the vault is open. */
  password: string;
  /** Name of the entry that would be updated (decision "update"). */
  entryName?: string;
  /** null only when locked is true */
  decision: "create" | "update" | null;
  locked: boolean;
}

/** What the panel sends on "Zapisz": the (possibly edited) data to save. */
export type SaveDraft = { name: string; username: string; password: string };

export type SavePreviewMessage = {
  target: "background";
  type: "save-preview";
  candidateId: string;
  username: string;
  password: string;
};
/** undefined: no such candidate, locked vault or a foreign sender. */
export type SavePreviewResponse =
  { decision: "create" | "update" | "none"; entryName?: string } | undefined;

export type SaveAnswerMessage = {
  target: "background";
  type: "save-answer";
  candidateId: string;
  answer: "save" | "later" | "never";
  /** Required for "save" from the panel; without it the candidate's own data is saved. */
  draft?: SaveDraft;
};
export type SaveAnswerResponse = { ok: true } | { ok: false; error: string };
