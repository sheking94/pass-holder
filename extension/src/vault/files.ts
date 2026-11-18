import type { p2p } from "@passholder/core";
import * as files from "@passholder/core/files";
import { errorMessage, FILE_CORRUPTED, toUserError } from "../error-messages.ts";
import { STORAGE_KEYS, type KeyValueStore } from "../storage.ts";
import { FILE_NOT_READY, LOCKED } from "./messages.ts";
import type { VaultSession } from "./session.ts";

/** What the file phase of a sync did; `error` (in Polish) when it stopped early. The entries are synced either way. */
export type FilesOutcome = files.FileSyncResult & { error?: string };

/**
 * The local copy of the attachments (encrypted chunks in IndexedDB) and the list of files known to be corrupted
 * (chrome.storage.local): their state, download, pruning, and the file phase of a sync.
 */
export class VaultFiles {
  constructor(
    private readonly session: VaultSession,
    private readonly local: KeyValueStore,
    private readonly store: files.LocalFileStore,
  ) {}

  /** "ready": the whole file is here; "corrupted": the phone's copy did not match; otherwise "waiting" for a sync. */
  async status(a: files.Attachment): Promise<"ready" | "waiting" | "corrupted"> {
    if ((await this.store.state(a.id))?.complete) return "ready";
    if ((await this.corruptIds()).includes(a.id)) return "corrupted";
    return "waiting";
  }

  /** The phone of the current epoch has the whole file (otherwise the screen adds "czeka na synchronizację"). */
  async uploaded(a: files.Attachment): Promise<boolean> {
    const vault = this.session.requireVault();
    const state = await this.store.state(a.id);
    return state !== undefined && state.uploadedEpoch === vault.epoch;
  }

  /** Decrypts a local file for download; only while unlocked. Nothing decrypted is kept. */
  async read(a: files.Attachment): Promise<Uint8Array> {
    this.session.requireVault();
    if (!(await this.store.state(a.id))?.complete) throw new Error(FILE_NOT_READY);
    const blobs: string[] = [];
    for (let index = 0; index < a.chunks; index++) {
      const blob = await this.store.getChunk(a.id, index);
      if (blob === undefined) throw new Error(FILE_CORRUPTED);
      blobs.push(blob);
    }
    try {
      return await files.decryptFile(a, blobs);
    } catch (error) {
      throw toUserError(error);
    }
  }

  /** Stores the chunks of a file encrypted on this browser (in a form or from an archive). */
  add(file: files.EncryptedFile): Promise<void> {
    return files.storeEncryptedFile(this.store, file);
  }

  /** Removes files no entry refers to; a failed delete is ignored, so it cannot hide the error that led here. */
  async discard(ids: Iterable<string>): Promise<void> {
    for (const id of ids) await this.store.delete(id).catch(() => undefined);
  }

  /**
   * Removes local files no live entry of `vault` uses, except files added on this browser and never uploaded
   * (complete, uploadedEpoch null). Every page shares IndexedDB but prunes against its own vault, which may be
   * stale: such a file may belong to an entry another page has saved but not synced yet.
   * Best effort: a failure is ignored (the next prune tries again).
   */
  async prune(vault: p2p.LocalVault): Promise<void> {
    try {
      const used = files.usedAttachments(vault);
      for (const id of await this.store.ids()) {
        if (used.has(id)) continue;
        const state = await this.store.state(id);
        if (state?.complete && state.uploadedEpoch === null) continue;
        await this.store.delete(id);
      }
    } catch {
      // Leftover files only take space; they are removed on a later prune or on disconnect.
    }
  }

  /** Disconnect: the files are the local copy of the vault's attachments, they go with it. */
  async removeAll(): Promise<void> {
    // The account is gone already, so a failing IndexedDB only leaves encrypted leftovers behind and must not
    // fail the disconnect.
    try {
      for (const id of await this.store.ids()) await this.store.delete(id);
    } catch {
      // Unreadable without the vault key; a later disconnect tries again.
    }
    await this.local.remove(STORAGE_KEYS.corruptFiles);
  }

  /**
   * Runs syncFiles and never throws: an error ends up in `error`. Newly found corrupted files are remembered
   * (skipped from now on); ids no live entry uses are dropped from that list. After a complete phase, unused
   * local files are pruned. Once the vault locks (auto-lock, „Zablokuj”) no further request is sent: the phase
   * ends with LOCKED and nothing is pruned.
   */
  async syncPhase(
    vault: p2p.LocalVault,
    send: files.P2pFileTransport,
    onProgress?: (done: number, total: number) => void,
  ): Promise<FilesOutcome> {
    const known = await this.corruptIds();
    const corrupt = new Set(known);
    const whileUnlocked: files.P2pFileTransport = async (request) => {
      if (!this.session.isCurrent(vault)) throw new Error(LOCKED);
      return send(request);
    };
    let outcome: FilesOutcome;
    try {
      outcome = await files.syncFiles(vault, this.store, whileUnlocked, {
        onProgress,
        skip: new Set(known),
      });
      for (const { id } of outcome.corrupted) corrupt.add(id);
      await this.prune(vault);
    } catch (error) {
      outcome = {
        uploaded: 0,
        downloaded: 0,
        pending: 0,
        corrupted: [],
        error: errorMessage(error),
      };
    }
    await this.keepCorrupt(vault, known, corrupt);
    return outcome;
  }

  /** Ids of files whose download did not match their descriptor; sync skips them. */
  private async corruptIds(): Promise<string[]> {
    return (await this.local.get<string[]>(STORAGE_KEYS.corruptFiles)) ?? [];
  }

  /** Saves the corrupt ids a live entry of `vault` still uses, when that differs from `known`. */
  private async keepCorrupt(
    vault: p2p.LocalVault,
    known: readonly string[],
    corrupt: ReadonlySet<string>,
  ): Promise<void> {
    const used = files.usedAttachments(vault);
    const kept = [...corrupt].filter((id) => used.has(id));
    if (kept.length !== known.length || kept.some((id, i) => id !== known[i]))
      await this.local.set(STORAGE_KEYS.corruptFiles, kept);
  }
}
