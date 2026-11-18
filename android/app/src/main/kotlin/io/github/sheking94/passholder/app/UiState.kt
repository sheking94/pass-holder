package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.app.entries.EntryType
import io.github.sheking94.passholder.core.p2p.PhoneEntry

sealed interface Screen {
    /** The screens that show what is in the vault: they must not stay on screen once it locks. */
    val showsVault: Boolean get() = false

    /** No vault on the phone: create one, or restore it from the extension. */
    data object Start : Screen
    data object Locked : Screen
    data object List : Screen {
        override val showsVault get() = true
    }

    /** [id] is null for a new entry of [type]. */
    data class Edit(val id: String?, val type: EntryType) : Screen {
        override val showsVault get() = true
    }

    /** "Ustawienia": fingerprint unlock and the lock delay. */
    data object Settings : Screen {
        override val showsVault get() = true
    }

    /** "Zmień hasło główne", opened from Ustawienia. */
    data object ChangePassword : Screen {
        override val showsVault get() = true
    }

    /** "Import i eksport": files of PassHolder, Bitwarden and NordPass. */
    data object Transfer : Screen {
        override val showsVault get() = true
    }

    /** Sync mode: the phone serves the extension. */
    data object Sync : Screen {
        override val showsVault get() = true
    }

    /** Paired extensions. */
    data object Devices : Screen {
        override val showsVault get() = true
    }

    /** "Odtwórz z wtyczki" in progress: the server runs and waits for the extension to send the vault. */
    data object Restore : Screen
}

data class Status(val text: String, val isError: Boolean = false)

data class UiState(
    val screen: Screen,
    val busy: Boolean = false,
    val status: Status? = null,
    val entries: List<PhoneEntry> = emptyList(),
    /** Records the vault key cannot open (e.g. sent by an extension of another vault). */
    val unreadable: Int = 0,
    /** The entry on [Screen.Edit], read from the store when it was opened (not from [entries], which may be older). */
    val editing: PhoneEntry? = null,
    /** host.json cannot be read: the start screen offers only to remove the vault from the phone. */
    val corruptVault: Boolean = false,
    /** The list's tab: the type of entries it shows. */
    val tab: EntryType = EntryType.LOGIN,
)

/** The tab the list comes back to: the edited entry's type, otherwise the current tab. */
internal fun UiState.returnTab(): EntryType = (screen as? Screen.Edit)?.type ?: tab
