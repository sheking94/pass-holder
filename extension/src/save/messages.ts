export type SaveCandidateMessage = {
  target: "background";
  type: "save-candidate";
  username: string;
  password: string;
  formSignature: string;
};

/** Sent by the top frame on every new page; the response says whether to show the panel. */
export type SavePendingMessage = { target: "background"; type: "save-pending"; emptyLoginForms: string[] };
export type SavePendingResponse = { candidateId?: string };

export type ToWatchMessage =
  | { target: "save-watch"; type: "save-show"; candidateId: string }
  | { target: "save-watch"; type: "save-hide" };

export type SaveInfoMessage = { target: "background"; type: "save-info"; candidateId?: string; tabId?: number };

export interface SavePromptInfo {
  id: string;
  host: string;
  username: string;
  /** null only when locked is true */
  decision: "create" | "update" | null;
  locked: boolean;
}

export type SaveAnswerMessage = {
  target: "background";
  type: "save-answer";
  candidateId: string;
  answer: "save" | "later" | "never";
};
export type SaveAnswerResponse = { ok: true } | { ok: false; error: string };
