package io.github.sheking94.passholder.app.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.sheking94.passholder.app.BiometricAvailability
import io.github.sheking94.passholder.app.LeaveLock
import io.github.sheking94.passholder.app.UiState
import android.provider.Settings as AndroidSettings

/** "Ustawienia": fingerprint unlock, the lock delay, autofill, the save prompt and "Zmień hasło główne". "Wróć" and the system back go to the list. */
@Composable
fun SettingsScreen(state: UiState, navigation: Navigation, fingerprint: FingerprintActions, settings: SettingsActions) {
    BackHandler(onBack = navigation::backToList)
    FormColumn {
        Text("Ustawienia", style = MaterialTheme.typography.headlineSmall)
        FingerprintSetting(state, fingerprint)
        LockDelaySetting(state, settings)
        AutofillSetting(settings)
        AskToSaveSetting(state, settings)
        OutlinedButton(onClick = navigation::openChangePassword, enabled = !state.busy) { Text("Zmień hasło główne") }
        OutlinedButton(onClick = navigation::backToList) { Text("Wróć") }
        StatusLine(state.status, state.busy)
    }
}

private const val NO_FINGERPRINT_HINT = "Najpierw dodaj odcisk palca w ustawieniach telefonu."

/** The switch that turns fingerprint unlock on and off. Hidden on phones without a strong fingerprint reader. */
@Composable
private fun FingerprintSetting(state: UiState, fingerprint: FingerprintActions) {
    val availability = remember { fingerprint.availability() }
    val enabled by fingerprint.enabled.collectAsStateWithLifecycle()
    val dialog = rememberFingerprintDialog(fingerprint)
    if (availability == BiometricAvailability.Unsupported && !enabled) return

    val canToggle = !state.busy && (enabled || availability == BiometricAvailability.Ready)
    SettingSwitchRow(
        "Odblokowanie odciskiem palca",
        checked = enabled,
        enabled = canToggle,
        onCheckedChange = { on ->
            if (on) {
                dialog.show("Włącz odblokowanie odciskiem palca", fingerprint::cipherToEnable, fingerprint::onEnableAuthorized)
            } else {
                fingerprint.disable()
            }
        },
        hint = if (availability == BiometricAvailability.NoFingerprint && !enabled) NO_FINGERPRINT_HINT else null,
    )
}

/** Leaving the app locks the vault after 60 s (on, default) or at once (off). */
@Composable
private fun LockDelaySetting(state: UiState, settings: SettingsActions) {
    val on by settings.lockDelay.collectAsStateWithLifecycle()
    SettingSwitchRow(
        "Blokuj dopiero po ${LeaveLock.DELAY_MS / 1000} s poza aplikacją",
        checked = on,
        enabled = !state.busy,
        onCheckedChange = settings::setLockDelay,
        hint = if (on) "Krótkie wyjście (np. wklejenie hasła) nie blokuje sejfu." else "Sejf blokuje się od razu po wyjściu z aplikacji.",
    )
}

/** Whether PassHolder offers to save a login typed into another app. */
@Composable
private fun AskToSaveSetting(state: UiState, settings: SettingsActions) {
    val on by settings.askToSave.collectAsStateWithLifecycle()
    SettingSwitchRow(
        "Pytaj o zapis haseł",
        checked = on,
        enabled = !state.busy,
        onCheckedChange = settings::setAskToSave,
        hint = if (on) "Po zalogowaniu PassHolder zapyta, czy zapisać hasło." else "PassHolder nie pyta o zapis.",
    )
}

/**
 * Whether PassHolder fills other apps' forms. When off, "Włącz" opens the system picker of the autofill service;
 * the state is read again each time the screen resumes, so it is right after coming back from the system settings.
 */
@Composable
private fun AutofillSetting(settings: SettingsActions) {
    val context = LocalContext.current
    var enabled by remember { mutableStateOf(settings.autofillEnabled()) }
    LifecycleResumeEffect(settings) {
        enabled = settings.autofillEnabled()
        onPauseOrDispose {}
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Autouzupełnianie", style = MaterialTheme.typography.bodyLarge)
            Text(if (enabled) "Włączone" else "Wyłączone", style = MaterialTheme.typography.bodySmall)
        }
        if (!enabled) {
            OutlinedButton(onClick = {
                val pick = Intent(AndroidSettings.ACTION_REQUEST_SET_AUTOFILL_SERVICE, Uri.parse("package:" + context.packageName))
                try {
                    context.startActivity(pick)
                } catch (e: ActivityNotFoundException) {
                    // Some phones have no such picker; the general settings at least lead there by hand.
                    context.startActivity(Intent(AndroidSettings.ACTION_SETTINGS))
                }
            }) { Text("Włącz") }
        }
    }
}
