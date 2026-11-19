package io.github.sheking94.passholder.app.ui

import androidx.activity.compose.LocalActivity
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.sheking94.passholder.app.UiState
import io.github.sheking94.passholder.app.UiTexts
import kotlinx.coroutines.flow.first

/**
 * The vault lives on the phone: unlocking needs no network.
 * With fingerprint unlock on, the system dialog opens by itself; the master password always works too.
 */
@Composable
fun LockedScreen(state: UiState, vault: VaultActions, fingerprint: FingerprintActions) {
    var askDisconnect by remember { mutableStateOf(false) }
    val biometricEnabled by fingerprint.enabled.collectAsStateWithLifecycle()
    val activity = LocalActivity.current
    val dialog = rememberFingerprintDialog(fingerprint)
    val unlockWithFinger = { dialog.show(UiTexts.UNLOCK_TITLE, fingerprint::cipherToUnlock, fingerprint::onUnlockAuthorized) }

    val timesLeftApp by fingerprint.timesLeftApp.collectAsStateWithLifecycle()

    // On app start and on every return to the app. Waits until the activity is in front: the system dialog
    // cannot be shown by an activity that is still in the background.
    LaunchedEffect(timesLeftApp) {
        (activity as? LifecycleOwner)?.lifecycle?.currentStateFlow?.first { it.isAtLeast(Lifecycle.State.RESUMED) }
        if (fingerprint.takeOfferOnLockedScreen()) unlockWithFinger()
    }

    UnlockForm("PassHolder jest zablokowany", state.busy, state.status, biometricEnabled, vault::unlock, { unlockWithFinger() }) {
        TextButton(onClick = { askDisconnect = true }, enabled = !state.busy) { Text("Usuń sejf z telefonu") }
    }

    if (askDisconnect) DisconnectDialog(onConfirm = vault::disconnect, onDismiss = { askDisconnect = false })
}
