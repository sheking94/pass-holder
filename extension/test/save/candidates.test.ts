import { describe, expect, it } from "vitest";
import { LOCKED } from "../../src/autofill/fill-tab.ts";
import {
  neverList,
  removeFromNever,
  SAVE_ALARM_PREFIX,
  SAVE_TTL_MS,
  SAVED_HIDE_MS,
  type Sender,
} from "../../src/save/candidates.ts";
import type { SaveCandidateMessage } from "../../src/save/messages.ts";
import { STORAGE_KEYS } from "../../src/storage.ts";
import { candidate, EXT, extSender, login, PAGE, scriptSender, setup } from "./save-fixture.ts";

describe("SaveCandidates", () => {
  it("stores a candidate and shows the panel", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const c = (await s.stored())["7"]!;
    expect(c.password).toBe("new");
    expect(await s.local.get(STORAGE_KEYS.saveCandidates)).toBeUndefined();
    expect(s.sent).toEqual([{ tabId: 7, m: { type: "save-show", candidateId: c.id } }]);
    expect(s.alarms.get(`${SAVE_ALARM_PREFIX}7`)).toBe(s.now() + SAVE_TTL_MS);
  }, 30_000);

  it("takes the address from sender.url, not the message", async () => {
    const s = await setup();
    await s.sc.onCandidate(
      { ...candidate(), url: "https://evil.example" } as SaveCandidateMessage,
      scriptSender(),
    );
    const c = (await s.stored())["7"]!;
    expect(c.url).toBe("shop.pl");
    expect(c.formSignature).toBe("https://shop.pl|u|p");
  }, 30_000);

  it("ignores messages without a tab or from another extension", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), { id: EXT, url: PAGE });
    await s.sc.onCandidate(candidate(), { ...scriptSender(), id: "other" });
    await s.sc.onCandidate(
      candidate(),
      scriptSender(7, "chrome-extension://x/a.html", "chrome-extension://x/a.html"),
    );
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([]);
  }, 30_000);

  it("ignores a frame from another origin than the tab", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender(7, "https://ads.example/frame", PAGE));
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([]);
  }, 30_000);

  it("skips hosts on the never list", async () => {
    const s = await setup();
    await s.local.set(STORAGE_KEYS.saveNever, ["shop.pl"]);
    await s.sc.onCandidate(candidate(), scriptSender());
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([]);
  }, 30_000);

  it("skips when the same login and password exist", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate({ password: "old" }), scriptSender());
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([]);
  }, 30_000);

  it("newer candidate replaces the older in the same tab, another tab keeps its own", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate({ password: "first" }), scriptSender(7));
    await s.sc.onCandidate(candidate({ password: "other" }), scriptSender(8));
    await s.sc.onCandidate(candidate({ password: "second" }), scriptSender(7));
    const all = await s.stored();
    expect(all["7"]!.password).toBe("second");
    expect(all["8"]!.password).toBe("other");
  }, 30_000);

  it("pending shows the panel within two minutes", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    s.advance(SAVE_TTL_MS - 1);
    expect(
      await s.sc.onPending(
        { target: "background", type: "save-pending", emptyLoginForms: [] },
        scriptSender(7, "https://shop.pl/home"),
      ),
    ).toEqual({ candidateId: id });
  }, 30_000);

  it("pending shows nothing after two minutes and drops the candidate", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    s.advance(SAVE_TTL_MS);
    expect(
      await s.sc.onPending(
        { target: "background", type: "save-pending", emptyLoginForms: [] },
        scriptSender(),
      ),
    ).toEqual({});
    expect(await s.stored()).toEqual({});
  }, 30_000);

  it("pending from another origin still shows the panel", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    const other = scriptSender(7, "https://sso.example/done", "https://sso.example/done");
    expect(
      await s.sc.onPending(
        { target: "background", type: "save-pending", emptyLoginForms: ["u|p"] },
        other,
      ),
    ).toEqual({ candidateId: id });
  }, 30_000);

  it("pending hides the panel when the same form came back empty", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const r = await s.sc.onPending(
      { target: "background", type: "save-pending", emptyLoginForms: ["x|y", "u|p"] },
      scriptSender(),
    );
    expect(r).toEqual({});
    expect(Object.keys(await s.stored())).toEqual(["7"]);
  }, 30_000);

  it("pending without a candidate answers nothing", async () => {
    const s = await setup();
    expect(
      await s.sc.onPending(
        { target: "background", type: "save-pending", emptyLoginForms: [] },
        scriptSender(),
      ),
    ).toEqual({});
  }, 30_000);

  it("info gives the password and the entry name to extension pages", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate({ username: "anna" }), scriptSender(7));
    await s.sc.onCandidate(candidate(), scriptSender(8));
    const c7 = (await s.stored())["7"]!;
    const create = await s.sc.info(
      { target: "background", type: "save-info", candidateId: c7.id },
      extSender,
    );
    expect(create).toEqual({
      id: c7.id,
      host: "shop.pl",
      username: "anna",
      password: "new",
      decision: "create",
      locked: false,
    });
    const update = await s.sc.info(
      { target: "background", type: "save-info", tabId: 8 },
      extSender,
    );
    expect(update).toMatchObject({
      host: "shop.pl",
      username: "jan",
      password: "new",
      decision: "update",
      entryName: "Shop",
      locked: false,
    });
  }, 30_000);

  it("preview decides from the typed login and password", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    const preview = (username: string, password: string) =>
      s.sc.preview(
        { target: "background", type: "save-preview", candidateId: id, username, password },
        extSender,
      );
    expect(await preview("jan", "new")).toEqual({ decision: "update", entryName: "Shop" });
    expect(await preview("anna", "x")).toEqual({ decision: "create" });
    expect(await preview("jan", "old")).toEqual({ decision: "none" });
    expect(await preview("jan", "")).toEqual({ decision: "update", entryName: "Shop" });
    expect(await preview("anna", "")).toEqual({ decision: "create" });
  }, 30_000);

  it("preview only from extension pages and with a live candidate", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    const msg = (candidateId: string) =>
      ({
        target: "background",
        type: "save-preview",
        candidateId,
        username: "jan",
        password: "x",
      }) as const;
    expect(await s.sc.preview(msg(id), scriptSender())).toBeUndefined();
    expect(await s.sc.preview(msg("nope"), extSender)).toBeUndefined();
    const locked = await setup({ locked: true });
    await locked.sc.onCandidate(candidate(), scriptSender());
    const lid = (await locked.stored())["7"]!.id;
    expect(await locked.sc.preview(msg(lid), extSender)).toBeUndefined();
  }, 60_000);

  it("info of a locked vault has no decision", async () => {
    const s = await setup({ locked: true });
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    expect(
      await s.sc.info({ target: "background", type: "save-info", candidateId: id }, extSender),
    ).toEqual({
      id,
      host: "shop.pl",
      username: "jan",
      password: "",
      decision: null,
      locked: true,
    });
  }, 30_000);

  it("info drops the candidate when after unlocking the login already exists", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    await s.store.putEntry("s1", login("Shop", ["https://shop.pl"], "jan", "new"));
    s.sent.length = 0;
    expect(
      await s.sc.info({ target: "background", type: "save-info", candidateId: id }, extSender),
    ).toBeUndefined();
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([{ tabId: 7, m: { type: "save-hide" } }]);
  }, 30_000);

  it("info and answer only from extension pages", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    const web: Sender = { id: EXT, url: PAGE, tab: { id: 7, url: PAGE } };
    expect(
      await s.sc.info({ target: "background", type: "save-info", candidateId: id }, web),
    ).toBeUndefined();
    expect(
      await s.sc.info(
        { target: "background", type: "save-info", candidateId: id },
        { ...extSender, id: "other" },
      ),
    ).toBeUndefined();
    expect(
      (
        await s.sc.answer(
          { target: "background", type: "save-answer", candidateId: id, answer: "save" },
          web,
        )
      ).ok,
    ).toBe(false);
    expect((await s.fresh()).pendingCount()).toBe(2);
  }, 30_000);

  it("answer save creates a login and hides the panel after SAVED_HIDE_MS", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate({ username: "anna" }), scriptSender());
    const id = (await s.stored())["7"]!.id;
    const before = (await s.fresh()).pendingCount();
    s.sent.length = 0;
    expect(
      await s.sc.answer(
        { target: "background", type: "save-answer", candidateId: id, answer: "save" },
        extSender,
      ),
    ).toEqual({ ok: true });
    expect((await s.fresh()).pendingCount()).toBe(before + 1);
    const created = (await s.fresh())
      .listEntries("login")
      .find((e) => e.data.type === "login" && e.data.fields.username === "anna")!;
    expect(created.data).toMatchObject({
      name: "shop.pl",
      fields: { password: "new", urls: ["shop.pl"] },
    });
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([]);
    expect(s.timers.map((t) => t.ms)).toEqual([SAVED_HIDE_MS]);
    s.timers[0]!.fn();
    expect(s.sent).toEqual([{ tabId: 7, m: { type: "save-hide" } }]);
  }, 30_000);

  it("answer save updates the password and keeps the old one as „Poprzednie hasło”", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    expect(
      await s.sc.answer(
        { target: "background", type: "save-answer", candidateId: id, answer: "save" },
        extSender,
      ),
    ).toEqual({ ok: true });
    const shop = (await s.fresh()).getEntry("s1")!;
    expect(shop.data).toMatchObject({
      name: "Shop",
      fields: { username: "jan", password: "new", urls: ["https://shop.pl"] },
    });
    expect(shop.data.custom).toEqual([{ label: "Poprzednie hasło", value: "old", hidden: true }]);
    expect((await s.fresh()).listEntries("login")).toHaveLength(2);
  }, 30_000);

  it("a subdomain never updates the parent domain's login (review V3-S2)", async () => {
    const s = await setup();
    const sub = "https://moje.bank.pl/login";
    // Same login and password as the parent domain: no question.
    await s.sc.onCandidate(candidate({ password: "bankpass" }), scriptSender(7, sub, sub));
    expect(await s.stored()).toEqual({});
    // A new password: a new login for the subdomain, the parent domain keeps its password.
    await s.sc.onCandidate(candidate(), scriptSender(7, sub, sub));
    expect(
      await s.sc.info({ target: "background", type: "save-info", tabId: 7 }, extSender),
    ).toMatchObject({ host: "moje.bank.pl", decision: "create" });
    const id = (await s.stored())["7"]!.id;
    expect(
      await s.sc.answer(
        { target: "background", type: "save-answer", candidateId: id, answer: "save" },
        extSender,
      ),
    ).toEqual({ ok: true });
    expect((await s.fresh()).getEntry("l1")!.data).toMatchObject({
      fields: { password: "bankpass" },
    });
    expect((await s.fresh()).listEntries("login")).toHaveLength(3);
  }, 30_000);

  it("answer save does nothing when the login appeared meanwhile", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    await s.store.putEntry("s1", login("Shop", ["https://shop.pl"], "jan", "new"));
    const before = (await s.fresh()).pendingCount();
    expect(
      await s.sc.answer(
        { target: "background", type: "save-answer", candidateId: id, answer: "save" },
        extSender,
      ),
    ).toEqual({ ok: true });
    expect((await s.fresh()).pendingCount()).toBe(before);
    expect(await s.stored()).toEqual({});
  }, 30_000);

  it("answer save uses the edited draft for a new login", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    const save = (name: string) =>
      s.sc.answer(
        {
          target: "background",
          type: "save-answer",
          candidateId: id,
          answer: "save",
          draft: { name, username: "anna", password: "p2" },
        },
        extSender,
      );
    expect(await save("  ")).toEqual({ ok: true });
    const created = (await s.fresh())
      .listEntries("login")
      .find((e) => e.data.type === "login" && e.data.fields.username === "anna")!;
    expect(created.data).toMatchObject({
      name: "shop.pl",
      fields: { username: "anna", password: "p2", urls: ["shop.pl"] },
    });

    const s2 = await setup();
    await s2.sc.onCandidate(candidate(), scriptSender());
    const id2 = (await s2.stored())["7"]!.id;
    await s2.sc.answer(
      {
        target: "background",
        type: "save-answer",
        candidateId: id2,
        answer: "save",
        draft: { name: "Mój sklep", username: "anna", password: "p2" },
      },
      extSender,
    );
    const named = (await s2.fresh())
      .listEntries("login")
      .find((e) => e.data.type === "login" && e.data.fields.username === "anna")!;
    expect(named.data).toMatchObject({ name: "Mój sklep" });
  }, 60_000);

  it("answer save with a draft for an existing login updates only its password", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate({ username: "anna" }), scriptSender());
    const id = (await s.stored())["7"]!.id;
    const draft = { name: "Inna nazwa", username: "jan", password: "p2" };
    expect(
      await s.sc.answer(
        { target: "background", type: "save-answer", candidateId: id, answer: "save", draft },
        extSender,
      ),
    ).toEqual({ ok: true });
    expect((await s.fresh()).getEntry("s1")!.data).toMatchObject({
      name: "Shop",
      fields: { username: "jan", password: "p2" },
    });
    expect((await s.fresh()).listEntries("login")).toHaveLength(2);
  }, 30_000);

  it("answer save of a draft already saved fails and hides the panel", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    s.sent.length = 0;
    const draft = { name: "Shop", username: "jan", password: "old" };
    expect(
      await s.sc.answer(
        { target: "background", type: "save-answer", candidateId: id, answer: "save", draft },
        extSender,
      ),
    ).toEqual({ ok: false, error: "Ten login jest już zapisany w PassHolder" });
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([{ tabId: 7, m: { type: "save-hide" } }]);
  }, 30_000);

  it("answer save with an empty draft password keeps the candidate", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    const draft = { name: "Shop", username: "jan", password: "" };
    expect(
      await s.sc.answer(
        { target: "background", type: "save-answer", candidateId: id, answer: "save", draft },
        extSender,
      ),
    ).toEqual({ ok: false, error: "Podaj hasło" });
    expect(Object.keys(await s.stored())).toEqual(["7"]);
  }, 30_000);

  it("hide and show messages carry no password", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate({ username: "anna" }), scriptSender());
    const id = (await s.stored())["7"]!.id;
    await s.sc.info({ target: "background", type: "save-info", candidateId: id }, extSender);
    await s.sc.answer(
      { target: "background", type: "save-answer", candidateId: id, answer: "save" },
      extSender,
    );
    s.timers[0]!.fn();
    expect(s.sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(s.sent)).not.toContain("new");
  }, 30_000);

  it("answer later removes the candidate and hides at once", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    s.sent.length = 0;
    expect(
      await s.sc.answer(
        { target: "background", type: "save-answer", candidateId: id, answer: "later" },
        extSender,
      ),
    ).toEqual({ ok: true });
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([{ tabId: 7, m: { type: "save-hide" } }]);
    expect(s.cleared).toContain(`${SAVE_ALARM_PREFIX}7`);
  }, 30_000);

  it("answer never adds the host to the list", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    s.sent.length = 0;
    expect(
      await s.sc.answer(
        { target: "background", type: "save-answer", candidateId: id, answer: "never" },
        extSender,
      ),
    ).toEqual({ ok: true });
    expect(await neverList(s.local)).toEqual(["shop.pl"]);
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([{ tabId: 7, m: { type: "save-hide" } }]);
    await removeFromNever(s.local, "shop.pl");
    expect(await neverList(s.local)).toEqual([]);
  }, 30_000);

  it("answer save when locked fails and keeps the candidate", async () => {
    const s = await setup({ locked: true });
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    expect(
      await s.sc.answer(
        { target: "background", type: "save-answer", candidateId: id, answer: "save" },
        extSender,
      ),
    ).toEqual({ ok: false, error: LOCKED });
    expect(Object.keys(await s.stored())).toEqual(["7"]);
  }, 30_000);

  it("answer save for an unknown candidate fails", async () => {
    const s = await setup();
    const r = await s.sc.answer(
      { target: "background", type: "save-answer", candidateId: "nope", answer: "save" },
      extSender,
    );
    expect(r).toEqual({ ok: false, error: "Pytanie o zapis wygasło" });
  }, 30_000);

  it("later or never for a gone candidate succeeds without touching any window (the page closes itself)", async () => {
    const s = await setup();
    const panel: Sender = {
      id: EXT,
      url: `chrome-extension://${EXT}/save-prompt.html?id=gone`,
      tab: { id: 70 },
    };
    expect(
      await s.sc.answer(
        { target: "background", type: "save-answer", candidateId: "gone", answer: "later" },
        extSender,
      ),
    ).toEqual({ ok: true });
    expect(
      await s.sc.answer(
        { target: "background", type: "save-answer", candidateId: "gone", answer: "never" },
        panel,
      ),
    ).toEqual({ ok: true });
    expect(s.sent).toEqual([]);
    expect(await neverList(s.local)).toEqual([]);
    const web: Sender = { id: EXT, url: PAGE, tab: { id: 7, url: PAGE } };
    expect(
      (
        await s.sc.answer(
          { target: "background", type: "save-answer", candidateId: "gone", answer: "later" },
          web,
        )
      ).ok,
    ).toBe(false);
  }, 30_000);

  it("later for a replaced candidate keeps the tab's current one", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    s.sent.length = 0;
    expect(
      await s.sc.answer(
        { target: "background", type: "save-answer", candidateId: "old", answer: "later" },
        extSender,
      ),
    ).toEqual({ ok: true });
    expect(s.sent).toEqual([]);
    expect(Object.keys(await s.stored())).toEqual(["7"]);
  }, 30_000);

  it("pending after a failed login (same form, empty) closes the window and keeps the badge", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    s.sent.length = 0;
    expect(
      await s.sc.onPending(
        { target: "background", type: "save-pending", emptyLoginForms: ["u|p"] },
        scriptSender(),
      ),
    ).toEqual({});
    expect(s.sent).toEqual([{ tabId: 7, m: { type: "close-window" } }]);
    expect(Object.keys(await s.stored())).toEqual(["7"]);
  }, 30_000);

  it("a window the user closed is not opened again on the next page, only the badge stays", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    await s.sc.onWindowClosed(7);
    await s.sc.onWindowClosed(9); // no candidate: nothing happens
    s.sent.length = 0;
    expect(
      await s.sc.onPending(
        { target: "background", type: "save-pending", emptyLoginForms: [] },
        scriptSender(7, "https://shop.pl/home"),
      ),
    ).toEqual({});
    expect(s.sent).toEqual([{ tabId: 7, m: { type: "badge" } }]);
    // The popup still shows the question for the tab.
    expect(
      (await s.sc.info({ target: "background", type: "save-info", tabId: 7 }, extSender))?.username,
    ).toBe("jan");
    // A new login in the tab asks again.
    await s.sc.onCandidate(candidate({ password: "newer" }), scriptSender());
    expect(s.sent.at(-1)?.m.type).toBe("save-show");
  }, 30_000);

  it("save-unlock gives the candidate's tab only to an extension page", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    const m = { target: "background" as const, type: "save-unlock" as const, candidateId: id };
    expect(await s.sc.unlockTab(m, extSender)).toBe(7);
    expect(await s.sc.unlockTab(m, scriptSender())).toBeUndefined();
    expect(await s.sc.unlockTab({ ...m, candidateId: "gone" }, extSender)).toBeUndefined();
  }, 30_000);

  it("the same login sent again by one submission keeps its id and refreshes the time", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    s.advance(60_000);
    await s.sc.onCandidate(candidate(), scriptSender());
    expect((await s.stored())["7"]!.id).toBe(id);
    expect(s.alarms.get(`${SAVE_ALARM_PREFIX}7`)).toBe(s.now() + SAVE_TTL_MS);
    s.advance(SAVE_TTL_MS - 1);
    expect(
      await s.sc.onPending(
        { target: "background", type: "save-pending", emptyLoginForms: [] },
        scriptSender(),
      ),
    ).toEqual({ candidateId: id });
    await s.sc.onCandidate(candidate({ password: "other" }), scriptSender());
    expect((await s.stored())["7"]!.id).not.toBe(id);
    await s.sc.onCandidate(candidate({ password: "other", formSignature: "x|y" }), scriptSender());
    const ids = s.sent.flatMap((x) => (x.m.type === "save-show" ? [x.m.candidateId] : []));
    expect(new Set(ids).size).toBe(3);
  }, 30_000);

  it("the alarm takes the question away, a closed tab only loses its window", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender(7));
    await s.sc.onCandidate(candidate(), scriptSender(8));
    s.sent.length = 0;
    await s.sc.onAlarm(`${SAVE_ALARM_PREFIX}7`);
    await s.sc.onAlarm(`${SAVE_ALARM_PREFIX}7`);
    await s.sc.onTabRemoved(8);
    expect(s.sent).toEqual([
      { tabId: 7, m: { type: "save-hide" } },
      { tabId: 8, m: { type: "close-window" } },
    ]);
  }, 30_000);

  it("an expired candidate found later takes the panel off the tab", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    s.sent.length = 0;
    s.advance(SAVE_TTL_MS);
    expect(
      await s.sc.info({ target: "background", type: "save-info", candidateId: id }, extSender),
    ).toBeUndefined();
    expect(await s.stored()).toEqual({});
    expect(s.sent).toEqual([{ tabId: 7, m: { type: "save-hide" } }]);
  }, 30_000);

  it("alarm and closed tab remove the candidate", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender(7));
    await s.sc.onCandidate(candidate(), scriptSender(8));
    await s.sc.onAlarm(`${SAVE_ALARM_PREFIX}7`);
    expect(Object.keys(await s.stored())).toEqual(["8"]);
    await s.sc.onAlarm("other");
    expect(Object.keys(await s.stored())).toEqual(["8"]);
    await s.sc.onTabRemoved(8);
    expect(await s.stored()).toEqual({});
  }, 30_000);

  it("check-only calls do not extend the unlocked time", async () => {
    const s = await setup();
    const before = (await s.session.get<{ unlockedUntil: number }>(STORAGE_KEYS.sessionKeys))!
      .unlockedUntil;
    s.advance(60_000);
    await s.sc.onCandidate(candidate(), scriptSender());
    const id = (await s.stored())["7"]!.id;
    await s.sc.info({ target: "background", type: "save-info", candidateId: id }, extSender);
    await s.sc.onPending(
      { target: "background", type: "save-pending", emptyLoginForms: [] },
      scriptSender(),
    );
    expect(
      (await s.session.get<{ unlockedUntil: number }>(STORAGE_KEYS.sessionKeys))!.unlockedUntil,
    ).toBe(before);
  }, 30_000);

  it("two concurrent answers save exactly once", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate({ username: "anna" }), scriptSender());
    const id = (await s.stored())["7"]!.id;
    const before = (await s.fresh()).listEntries("login").length;
    const msg = {
      target: "background",
      type: "save-answer",
      candidateId: id,
      answer: "save",
    } as const;
    const results = await Promise.all([s.sc.answer(msg, extSender), s.sc.answer(msg, extSender)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await s.fresh()).listEntries("login")).toHaveLength(before + 1);
  }, 30_000);

  it("concurrent candidates from two tabs are both kept", async () => {
    const s = await setup();
    await Promise.all([
      s.sc.onCandidate(candidate(), scriptSender(7)),
      s.sc.onCandidate(candidate(), scriptSender(8)),
    ]);
    expect(Object.keys(await s.stored()).sort()).toEqual(["7", "8"]);
  }, 30_000);

  it("pending from a frame of another origin than the tab shows nothing", async () => {
    const s = await setup();
    await s.sc.onCandidate(candidate(), scriptSender());
    const r = await s.sc.onPending(
      { target: "background", type: "save-pending", emptyLoginForms: [] },
      scriptSender(7, "https://ads.example/f", PAGE),
    );
    expect(r).toEqual({});
  }, 30_000);
});
