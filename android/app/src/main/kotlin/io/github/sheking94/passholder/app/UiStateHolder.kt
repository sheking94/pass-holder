package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.app.entries.EntryType
import io.github.sheking94.passholder.app.ui.StatusActions
import io.github.sheking94.passholder.core.p2p.PhoneVaultStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * The [UiState] that every part of AppViewModel changes, and the two ways they run work off the main thread:
 * [launchOperation] (a vault operation, one at a time, with `busy` and a progress line) and [launchCatching]
 * (short work that only reports its error). Also the status line and the entry list.
 */
internal class UiStateHolder(
    private val store: PhoneVaultStore,
    val scope: CoroutineScope,
    initial: UiState,
    /** After every vault operation (see LockController.onOperationFinished). */
    private val onOperationFinished: () -> Unit,
) : StatusActions {
    private val _state = MutableStateFlow(initial)
    val state: StateFlow<UiState> = _state.asStateFlow()

    val current: UiState get() = _state.value

    val busy: Boolean get() = _state.value.busy

    /** One read at a time: an older read finishing last would put a stale list on screen (seen in CI). */
    private val refreshing = Mutex()

    fun update(change: (UiState) -> UiState) = _state.update(change)

    /** A new screen from scratch (nothing of the old state is kept). */
    fun replace(state: UiState) {
        _state.value = state
    }

    override fun fail(message: String) = update { it.copy(status = Status(message, isError = true)) }

    override fun clearError() = update { if (it.status?.isError == true) it.copy(status = null) else it }

    fun showStatus(text: String) = update { it.copy(status = Status(text)) }

    /** The list, read now (blocking: for code already off the main thread). */
    fun showList(message: String?, tab: EntryType = EntryType.LOGIN) {
        replace(
            UiState(
                Screen.List,
                entries = store.entries(),
                unreadable = store.unreadableIds().size,
                status = message?.let { Status(it) },
                tab = tab,
            ),
        )
    }

    /** The list for a vault unlocked elsewhere; the entries are read off the main thread, the locked screen stays until then. */
    fun showListUnlockedElsewhere() {
        scope.launch {
            val read = withContext(Dispatchers.IO) { runCatching { store.entries() to store.unreadableIds().size } }
            read.onSuccess { (entries, unreadable) ->
                if (store.isUnlocked && current.screen == Screen.Locked && !current.busy) {
                    replace(UiState(Screen.List, entries = entries, unreadable = unreadable))
                }
            }
        }
    }

    /** [refresh] in the background, e.g. after a sync or an import changed the entries. */
    fun refreshInBackground() {
        scope.launch { refresh() }
    }

    /**
     * Reads the entries off the main thread (decrypting every record). Does nothing if the vault locked meanwhile:
     * decrypted entries never go into the state of a locked screen.
     */
    suspend fun refresh() = refreshing.withLock {
        if (!store.isUnlocked) return@withLock
        val read = withContext(Dispatchers.IO) { runCatching { store.entries() to store.unreadableIds().size } }
        read.onSuccess { (entries, unreadable) ->
            update { if (store.isUnlocked) it.copy(entries = entries, unreadable = unreadable) else it }
        }
    }

    /**
     * Runs a blocking vault operation off the main thread, with a [progress] line and its error on the status line.
     * Ignored while another one runs. [onSuccess] runs on the main thread once the operation ended without an error.
     */
    fun launchOperation(progress: String, onSuccess: () -> Unit = {}, action: () -> Unit) {
        if (busy) return
        update { it.copy(busy = true, status = Status(progress)) }
        scope.launch {
            val succeeded = try {
                withContext(Dispatchers.IO) { action() }
                true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(errorMessage(e))
                false
            } finally {
                update { it.copy(busy = false) }
                onOperationFinished()
            }
            if (succeeded) onSuccess()
        }
    }

    /** Runs [block] (not a vault operation: no `busy`, no progress line); an error goes to the status line. */
    fun launchCatching(block: suspend () -> Unit) {
        scope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(errorMessage(e))
            }
        }
    }
}
