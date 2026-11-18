import { fromBase64, p2p } from "@passholder/core";
import * as files from "@passholder/core/files";
import type { PhoneClient } from "../phone-client.ts";
import { pickPhone, withLearned } from "../phone-urls.ts";
import { openStaticKey, type Account, type AccountStore } from "./account.ts";
import type { FilesOutcome, VaultFiles } from "./files.ts";
import { inUserTerms, NO_ALLOWED_ADDRESS } from "./messages.ts";
import type { VaultSession } from "./session.ts";

/**
 * What a sync did besides syncing: addresses it did not try because Chrome does not allow them yet, and
 * the outcome of the file phase.
 */
export interface SyncResult {
  skipped: string[];
  files: FilesOutcome;
}

export type FileProgress = (done: number, total: number) => void;

/** Sync of the unlocked vault with the paired phone: entries, then files, then the learned addresses. */
export class VaultSync {
  constructor(
    private readonly session: VaultSession,
    private readonly accounts: AccountStore,
    private readonly files: VaultFiles,
    private readonly makeClient: (url: string) => PhoneClient,
    private readonly canReach: (url: string) => Promise<boolean>,
  ) {}

  /**
   * Syncs with the phone at the first address that answers (the one that worked last time is tried first),
   * over Noise KK with this browser's static key and the phone's key from pairing. Addresses the phone
   * reports are added to phoneUrls; typed ones stay. Addresses Chrome does not allow yet (e.g. learned ones
   * the user has not approved) are skipped and returned, so the screen can say where to allow them.
   * After the entries, the file phase uploads and downloads attachments over the same address and keys; its
   * failure does not undo the entries and is reported in `files.error` (the next sync resumes).
   */
  async sync(onFileProgress?: FileProgress): Promise<SyncResult> {
    const vault = this.session.requireVault();
    const vaultKey = this.session.requireVaultKey();
    const clock = this.session.requireClock();
    const account = await this.accounts.require();
    const { allowed, skipped } = await this.splitByPermission(account.phoneUrls);
    if (allowed.length === 0) throw new Error(NO_ALLOWED_ADDRESS);
    const { url, client } = await pickPhone(allowed, this.makeClient, account.lastPhoneUrl);
    const noise: p2p.NoiseClientOptions = {
      baseUrl: url,
      deviceId: account.deviceId,
      staticKey: p2p.keyPairFromPrivateKey(await openStaticKey(vaultKey, account)),
      peerPublicKey: fromBase64(account.phone.staticPublicKey),
      post: client.post,
    };
    await inUserTerms(() => p2p.syncVault(vault, vaultKey, clock, p2p.noiseTransport(noise)));
    await this.session.save();
    const filesOutcome = await this.files.syncPhase(
      vault,
      files.noiseFileTransport(noise),
      onFileProgress,
    );
    await this.learnAddresses(account, vault, url, skipped);
    return { skipped, files: filesOutcome };
  }

  private async splitByPermission(
    urls: readonly string[],
  ): Promise<{ allowed: string[]; skipped: string[] }> {
    const allowed: string[] = [];
    const skipped: string[] = [];
    for (const u of urls) ((await this.canReach(u)) ? allowed : skipped).push(u);
    return { allowed, skipped };
  }

  /**
   * Adds the addresses the phone reported and remembers the one that answered. Another page may have changed the
   * account during the sync (addresses, a repair): merge into the current one, and only while it is still the
   * same phone; otherwise its state wins. New addresses Chrome does not allow yet are added to `skipped`.
   */
  private async learnAddresses(
    account: Account,
    vault: p2p.LocalVault,
    url: string,
    skipped: string[],
  ): Promise<void> {
    const current = await this.accounts.get();
    if (!current || current.phone.staticPublicKey !== account.phone.staticPublicKey) return;
    const phoneUrls = withLearned(current.phoneUrls, vault.addresses);
    const lastPhoneUrl = phoneUrls.includes(url) ? url : current.lastPhoneUrl;
    if (lastPhoneUrl !== current.lastPhoneUrl || phoneUrls.length !== current.phoneUrls.length) {
      await this.accounts.save({ ...current, phoneUrls, lastPhoneUrl });
    }
    for (const u of phoneUrls)
      if (!account.phoneUrls.includes(u) && !skipped.includes(u) && !(await this.canReach(u)))
        skipped.push(u);
  }
}
