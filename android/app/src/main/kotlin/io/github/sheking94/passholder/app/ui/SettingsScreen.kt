package io.github.sheking94.passholder.app.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.provider.Settings as AndroidSettings
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.BiometricAvailability
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.app.UiState

/** "Ustawienia": fingerprint unlock, the lock delay, autofill, the save prompt and "Zmień hasło główne". "Wróć" and the system back go to the list. */
@Composable
fun SettingsScreen(state: UiState, vm: AppViewModel) {
    BackHandler(onBack = vm::backToList)
    FormColumn {
        Text("Ustawienia", style = MaterialTheme.typography.headlineSmall)
        FingerprintSetting(state, vm)
        LockDelaySetting(state, vm)
        AutofillSetting()
        AskToSaveSetting(state, vm)
        OutlinedButton(onClick = vm::openChangePassword, enabled = !state.busy) { Text("Zmień hasło główne") }
        OutlinedButton(onClick = vm::backToList) { Text("Wróć") }
        StatusLine(state.status, state.busy)
    }
}

/** The switch that turns fingerprint unlock on and off. Hidden on phones without a strong fingerprint reader. */
@Composable
private fun FingerprintSetting(state: UiState, vm: AppViewModel) {
    val availability = remember { vm.biometricAvailability() }
    val enabled by vm.biometricEnabled.collectAsStateWithLifecycle()
    val fingerprint = rememberFingerprintDialog(vm)
    if (availability == BiometricAvailability.Unsupported && !enabled) return

    val canToggle = !state.busy && (enabled || availability == BiometricAvailability.Ready)
    // The whole row is the switch, so tapping the label works too.
    Row(
        Modifier.fillMaxWidth().toggleable(value = enabled, enabled = canToggle, role = Role.Switch) { on ->
            if (on) fingerprint.show("Włącz odblokowanie odciskiem palca", vm::cipherToEnableBiometric, vm::onBiometricEnableAuthorized)
            else vm.disableBiometric()
        },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("Odblokowanie odciskiem palca", style = MaterialTheme.typography.bodyLarge)
            if (availability == BiometricAvailability.NoFingerprint && !enabled) {
                Text("Najpierw dodaj odcisk palca w ustawieniach telefonu.", style = MaterialTheme.typography.bodySmall)
            }
        }
        Switch(checked = enabled, onCheckedChange = null, enabled = canToggle)
    }
}

/** Leaving the app locks the vault after 60 s (on, default) or at once (off). */
@Composable
private fun LockDelaySetting(state: UiState, vm: AppViewModel) {
    val on by vm.lockDelay.collectAsStateWithLifecycle()
    Row(
        Modifier.fillMaxWidth().toggleable(value = on, enabled = !state.busy, role = Role.Switch) { vm.setLockDelay(it) },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("Blokuj dopiero po 60 s poza aplikacją", style = MaterialTheme.typography.bodyLarge)
            Text(
                if (on) "Krótkie wyjście (np. wklejenie hasła) nie blokuje sejfu." else "Sejf blokuje się od razu po wyjściu z aplikacji.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Switch(checked = on, onCheckedChange = null, enabled = !state.busy)
    }
}

/** Whether PassHolder offers to save a login typed into another app. */
@Composable
private fun AskToSaveSetting(state: UiState, vm: AppViewModel) {
    val on by vm.askToSave.collectAsStateWithLifecycle()
    Row(
        Modifier.fillMaxWidth().toggleable(value = on, enabled = !state.busy, role = Role.Switch) { vm.setAskToSave(it) },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("Pytaj o zapis haseł", style = MaterialTheme.typography.bodyLarge)
            Text(
                if (on) "Po zalogowaniu PassHolder zapyta, czy zapisać hasło." else "PassHolder nie pyta o zapis.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Switch(checked = on, onCheckedChange = null, enabled = !state.busy)
    }
}

/**
 * Whether PassHolder fills other apps' forms. When off, "Włącz" opens the system picker of the autofill service;
 * the state is read again each time the screen resumes, so it is right after coming back from the system settings.
 */
@Composable
private fun AutofillSetting() {
    val context = LocalContext.current
    val status = remember { (context.applicationContext as PassHolderApp).autofillStatus }
    var enabled by remember { mutableStateOf(status.isEnabled()) }
    LifecycleResumeEffect(status) {
        enabled = status.isEnabled()
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
