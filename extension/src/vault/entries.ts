import { p2p } from "@passholder/core";
import type * as files from "@passholder/core/files";
import { toUserError } from "../error-messages.ts";
import type { VaultFiles } from "./files.ts";
import { storedView, type StoredEntry } from "./local-vault.ts";
import { OTHER_TYPE } from "./messages.ts";
import type { VaultSession } from "./session.ts";

/** The entries of the unlocked vault. Every change is saved to disk before the method returns. */
export class VaultEntries {
  constructor(
    private readonly session: VaultSession,
    private readonly files: VaultFiles,
  ) {}

  /** Live entries of one type, sorted by name (Polish collation). */
  list(type: p2p.EntryType): StoredEntry[] {
    return this.live()
      .filter((e) => e.data.type === type)
      .sort((a, b) => a.data.name.localeCompare(b.data.name, "pl"));
  }

  /** A live entry of any type. */
  get(id: string): StoredEntry | undefined {
    const entry = this.session.requireVault().entries.get(id);
    return entry && storedView(entry);
  }

  /** Content of all live entries of every type (no `v` or `hlc`), for export. */
  allContents(): p2p.EntryContent[] {
    return this.live().map((e) => e.data);
  }

  /** Number of local changes the phone has not seen yet. */
  pendingCount(): number {
    return [...this.session.requireVault().entries.values()].filter((e) => e.dirty).length;
  }

  /**
   * Saves exactly this content under id; a live entry of another type under that id is refused. newFiles
   * (encrypted when chosen in the form) are stored before the entry; if the entry is refused (e.g. too large)
   * they are removed again. Afterwards unused local files are pruned (see VaultFiles.prune).
   */
  async put(
    id: string,
    content: p2p.EntryContent,
    newFiles: readonly files.EncryptedFile[] = [],
  ): Promise<void> {
    const vault = this.session.requireVault();
    const clock = this.session.requireClock();
    const existing = vault.entries.get(id);
    if (existing && !existing.deleted && existing.data.type !== content.type)
      throw new Error(OTHER_TYPE);
    try {
      for (const f of newFiles) await this.files.add(f);
      // Storing the files takes a while: the vault may have locked meanwhile, then the entry is not saved.
      this.session.requireKeys();
      try {
        p2p.upsertEntry(vault, clock, id, content);
      } catch (error) {
        throw toUserError(error);
      }
    } catch (error) {
      await this.files.discard(newFiles.map((f) => f.attachment.id));
      throw error;
    }
    // The entry in memory refers to the new files now, so they stay even if saving to disk fails.
    await this.session.save();
    await this.files.prune(vault);
  }

  async delete(id: string): Promise<void> {
    const vault = this.session.requireVault();
    p2p.deleteEntry(vault, this.session.requireClock(), id);
    await this.session.save();
    await this.files.prune(vault);
  }

  private live(): StoredEntry[] {
    return [...this.session.requireVault().entries.values()].flatMap((e) => storedView(e) ?? []);
  }
}
