/**
 * Outcome of an action that can fail with a text for the user (fill a page, answer the save question). It is
 * sent between the background and the pages as a message, so it is plain data, not an Error.
 */
export type ActionResult = { ok: true } | { ok: false; error: string };
