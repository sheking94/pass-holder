import { describe, expect, it } from "vitest";
import {
  disableSavePrompt,
  syncSaveWatch,
  type SaveWatchApi,
} from "../../src/save/registration.ts";

function fakeApi(granted: string[], registeredNow: boolean) {
  const calls: string[] = [];
  const state = { granted: [...granted], registered: registeredNow };
  const api: SaveWatchApi = {
    contains: async (origins) => origins.every((o) => state.granted.includes(o)),
    remove: async (origins) => {
      calls.push(`remove ${origins.join(",")}`);
      state.granted = state.granted.filter((o) => !origins.includes(o));
      return true;
    },
    registered: async () => state.registered,
    register: async () => void (calls.push("register"), (state.registered = true)),
    unregister: async () => void (calls.push("unregister"), (state.registered = false)),
  };
  return { api, calls, state };
}

describe("syncSaveWatch", () => {
  it("registers the script when the permission is there", async () => {
    const { api, calls } = fakeApi(["https://*/*"], false);
    await syncSaveWatch(api);
    expect(calls).toEqual(["register"]);
  });

  it("unregisters it when the user took the permission away", async () => {
    const { api, calls } = fakeApi([], true);
    await syncSaveWatch(api);
    expect(calls).toEqual(["unregister"]);
  });

  it("does not register twice, nor unregister what is not there", async () => {
    const on = fakeApi(["https://*/*"], true);
    await syncSaveWatch(on.api);
    await syncSaveWatch(on.api);
    const off = fakeApi([], false);
    await syncSaveWatch(off.api);
    expect(on.calls).toEqual([]);
    expect(off.calls).toEqual([]);
  });
});

describe("syncSaveWatch, overlapping calls", () => {
  it("runs one after another, so the script is registered once", async () => {
    const { api, calls } = fakeApi(["https://*/*"], false);
    const slow: SaveWatchApi = {
      ...api,
      registered: async () => {
        const now = await api.registered();
        await new Promise((r) => setTimeout(r, 5));
        return now;
      },
    };
    await Promise.all([syncSaveWatch(slow), syncSaveWatch(slow), syncSaveWatch(slow)]);
    expect(calls).toEqual(["register"]);
  });

  it("a failed call does not stop the next one", async () => {
    const { api, calls } = fakeApi(["https://*/*"], false);
    const failing: SaveWatchApi = {
      ...api,
      register: async () => {
        throw new Error("Duplicate script ID");
      },
    };
    await expect(syncSaveWatch(failing)).rejects.toThrow("Duplicate script ID");
    await syncSaveWatch(api);
    expect(calls).toEqual(["register"]);
  });
});

describe("disableSavePrompt", () => {
  it("keeps http access while a phone address is http", async () => {
    const { api, calls } = fakeApi(["https://*/*", "http://*/*"], true);
    await disableSavePrompt(api, ["http://192.168.1.5:8787"]);
    expect(calls).toEqual(["remove https://*/*"]);
  });

  it("removes both when no phone address needs http", async () => {
    const { api, calls } = fakeApi(["https://*/*", "http://*/*"], true);
    await disableSavePrompt(api, ["https://phone.example"]);
    expect(calls).toEqual(["remove https://*/*", "remove http://*/*"]);
  });
});
