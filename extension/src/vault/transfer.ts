import { hasErrorCode, PassHolderError, p2p, transfer } from "@passholder/core";
import * as files from "@passholder/core/files";
import { errorMessage } from "../error-messages.ts";
import type { VaultEntries } from "./entries.ts";
import type { VaultFiles } from "./files.ts";
import { inUserTerms } from "./messages.ts";
import type { VaultSession } from "./session.ts";

/** What importContents() did: how many entries were added, were already in the vault, or were too large. */
export interface ImportResult {
  added: number;
  duplicates: number;
  tooLarge: number;
}

export interface ArchiveExport {
  parts: Uint8Array[];
  entries: number;
  files: number;
  missing: number;
}

export interface ArchiveImport {
  parsed: transfer.ParsedArchive;
  result: ImportResult;
  filesAdded: number;
  fileSkips: transfer.ImportSkip[];
}

/** A described file of an archive, checked to have the described size (the archive reader checks it too). */
async function readArchivedFile(
  archive: transfer.OpenedArchive,
  f: transfer.ArchivedFile,
): Promise<Uint8Array> {
  const plain = await archive.readFile(f);
  if (plain.length !== f.size) {
    plain.fill(0);
    throw new PassHolderError("ARCHIVE_FILE_SIZE_MISMATCH");
  }
  return plain;
}

/** Import of entries (any format, parsed already) and PassHolder ZIP archives, and export to a ZIP. */
export class VaultTransfer {
  constructor(
    private readonly session: VaultSession,
    private readonly entries: VaultEntries,
    private readonly files: VaultFiles,
  ) {}

  /**
   * Adds imported entries of any type as new local changes. An entry whose whole content (see
   * transfer.contentKey) is already in the vault as a live entry, or came earlier in this import,
   * is skipped as a duplicate; one over the size limit is counted in tooLarge. Saves once at the end.
   */
  async importContents(
    entries: readonly p2p.EntryContent[],
    newId: () => string = () => crypto.randomUUID(),
  ): Promise<ImportResult> {
    const vault = this.session.requireVault();
    const clock = this.session.requireClock();
    const known = this.knownContents();
    // upsertEntry replaces map entries (never edits them in place), so a copy of the map is a full snapshot.
    // The clock only moves forward, which is harmless to keep.
    const snapshot = new Map(vault.entries);
    let added = 0;
    let tooLarge = 0;
    try {
      for (const entry of entries) {
        const key = transfer.contentKey(entry);
        if (known.has(key)) continue;
        try {
          p2p.upsertEntry(vault, clock, newId(), entry);
        } catch (error) {
          if (hasErrorCode(error, "ENTRY_TOO_LARGE")) {
            tooLarge++;
            continue;
          }
          throw error;
        }
        known.add(key);
        added++;
      }
      if (added > 0) await this.session.save();
    } catch (error) {
      // Nothing half-imported may stay in memory, where it could still reach the disk or the phone later.
      vault.entries.clear();
      for (const [id, entry] of snapshot) vault.entries.set(id, entry);
      throw error;
    }
    return { added, duplicates: entries.length - added - tooLarge, tooLarge };
  }

  /**
   * A PassHolder ZIP of all live entries and their files. A file that is not complete here (waiting for sync) or
   * cannot be decrypted is left out and counted in `missing`; locking meanwhile fails the export.
   */
  async exportArchive(): Promise<ArchiveExport> {
    const entries = this.entries.allContents();
    const {
      parts,
      files: written,
      missing,
    } = await transfer.exportPassHolderZip(entries, async (a) => {
      this.session.requireVault();
      if ((await this.files.status(a)) !== "ready") return undefined;
      try {
        return await this.files.read(a);
      } catch {
        // Damaged here: the entry goes out without this file.
        return undefined;
      }
    });
    this.session.requireVault();
    return { parts, entries: entries.length, files: written, missing };
  }

  /**
   * Imports a PassHolder ZIP. Entries already in the vault (transfer.contentKey, files ignored) are skipped with their
   * files; repeats within the archive are left to importContents. The files of the other entries are read, encrypted
   * and stored under new ids; a file that cannot be read is skipped ("wpis N, nazwa") and its entry comes in
   * without it. Any other failure (damaged archive, file store, the vault locking) imports nothing and removes the
   * files stored so far. Afterwards the stored files no live entry uses (a repeat, a too large entry) are removed.
   */
  async importArchive(bytes: Uint8Array): Promise<ArchiveImport> {
    const vault = this.session.requireVault();
    const archive = await inUserTerms(() => transfer.openPassHolderZip(bytes));
    const { parsed } = archive;
    const added: string[] = [];
    const fileSkips: transfer.ImportSkip[] = [];
    let result: ImportResult;
    try {
      const contents = await this.withStoredFiles(archive, added, fileSkips);
      this.session.requireKeys();
      result = await this.importContents(contents);
    } catch (error) {
      await this.files.discard(added);
      throw error;
    }
    // The entries are written: from here on only files no live entry uses may be removed (also if the vault has
    // locked since: the vault object still holds the entries).
    const used = files.usedAttachments(vault);
    const filesAdded = added.filter((id) => used.has(id)).length;
    // Best effort, like VaultFiles.prune; the import itself succeeded. A leftover is removed on disconnect.
    await this.files.discard(added.filter((id) => !used.has(id)));
    return { parsed, result, filesAdded, fileSkips };
  }

  /**
   * The archive's entries, those not in the vault yet with their files stored under new ids (see
   * storeArchivedFiles). Only checked against the vault: importContents drops repeats within the archive, and it
   * may refuse the first copy as too large, so a later copy must still bring its files.
   */
  private async withStoredFiles(
    archive: transfer.OpenedArchive,
    added: string[],
    fileSkips: transfer.ImportSkip[],
  ): Promise<p2p.EntryContent[]> {
    const known = this.knownContents();
    const contents: p2p.EntryContent[] = [];
    for (const e of archive.parsed.entries) {
      if (known.has(transfer.contentKey(e.content))) {
        contents.push(e.content);
        continue;
      }
      const attachments = await this.storeArchivedFiles(archive, e, added, fileSkips);
      contents.push(attachments.length > 0 ? { ...e.content, attachments } : e.content);
    }
    return contents;
  }

  /**
   * The files of one archived entry, each read, encrypted and stored under a new id (pushed to `added` before it is
   * stored, so a half-stored file is removed too). A file that cannot be read goes to `fileSkips` ("wpis N, nazwa").
   */
  private async storeArchivedFiles(
    archive: transfer.OpenedArchive,
    entry: transfer.ArchiveEntry,
    added: string[],
    fileSkips: transfer.ImportSkip[],
  ): Promise<files.Attachment[]> {
    const attachments: files.Attachment[] = [];
    for (const f of entry.files) {
      let plain: Uint8Array;
      try {
        plain = await readArchivedFile(archive, f);
      } catch (error) {
        fileSkips.push({ at: `wpis ${entry.position}, ${f.name}`, reason: errorMessage(error) });
        continue;
      }
      let encrypted: files.EncryptedFile;
      try {
        encrypted = await files.encryptFile(plain, { name: f.name, mime: f.mime });
      } finally {
        // Only the encrypted chunks are kept.
        plain.fill(0);
      }
      added.push(encrypted.attachment.id);
      await this.files.add(encrypted);
      // Storing takes a while: stop as soon as the vault locks.
      this.session.requireKeys();
      attachments.push(encrypted.attachment);
    }
    return attachments;
  }

  private knownContents(): Set<string> {
    return new Set(this.entries.allContents().map(transfer.contentKey));
  }
}
