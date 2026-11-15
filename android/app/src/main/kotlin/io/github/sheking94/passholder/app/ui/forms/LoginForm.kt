package io.github.sheking94.passholder.app.ui.forms

import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import io.github.sheking94.passholder.app.InstalledApp
import io.github.sheking94.passholder.app.PassHolderApp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.input.KeyboardType
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.ui.PlainField
import io.github.sheking94.passholder.app.ui.SecretField
import io.github.sheking94.passholder.core.p2p.LoginFields

/** Login section: login, password with the generator, TOTP, web addresses and Android apps. */
@Composable
fun LoginForm(fields: LoginFields, onChange: (LoginFields) -> Unit, vm: AppViewModel) {
    var passwordShown by remember { mutableStateOf(false) }
    PlainField(fields.username, { onChange(fields.copy(username = it)) }, "Login", onCopy = { vm.copy("login", fields.username, sensitive = false) })
    SecretField(
        fields.password,
        { onChange(fields.copy(password = it)) },
        "Hasło",
        onCopy = { vm.copy("hasło", fields.password, sensitive = true) },
        monospace = true,
        revealed = passwordShown,
        onRevealedChange = { passwordShown = it },
    )
    GeneratorCard(vm) {
        onChange(fields.copy(password = it))
        passwordShown = true
    }
    SecretField(fields.totp, { onChange(fields.copy(totp = it)) }, "TOTP", onCopy = { vm.copy("kod TOTP", fields.totp, sensitive = true) }, monospace = true)
    ListEditor("Adresy stron", fields.urls, { onChange(fields.copy(urls = it)) }, "Dodaj adres", { "" }) { url, update ->
        PlainField(url, update, "Adres strony", keyboardType = KeyboardType.Uri, placeholder = "https://")
    }
    val apps = rememberInstalledApps()
    val labels = apps.orEmpty().associate { it.packageName to it.label }
    var picking by remember { mutableStateOf(false) }
    val phApp = LocalContext.current.applicationContext as PassHolderApp
    val scope = rememberCoroutineScope()
    ListEditor(
        "Aplikacje Androida",
        fields.androidApps,
        { onChange(fields.copy(androidApps = it)) },
        "Wpisz pakiet",
        { "" },
        extraActions = { TextButton(onClick = { picking = true }) { Text("+ Wybierz aplikację") } },
    ) { app, update ->
        // Decided once per row (rows have stable keys) and again when the app list arrives, never while typing:
        // a hand-typed package stays an editable field even if it equals an installed one on the way.
        val label = remember(apps != null) { labels[app] }
        if (label != null) Text("$label · $app") else PlainField(app, update, "Nazwa pakietu", placeholder = "np. pl.mbank")
    }
    if (picking) {
        AppPickerDialog(
            apps.orEmpty(),
            onPick = { pkg ->
                // The picked installed app is the one tied to the login: remember its certificate (V3-S3).
                scope.launch(Dispatchers.IO) { runCatching { phApp.appTrust.remember(pkg) } }
                if (pkg !in fields.androidApps) onChange(fields.copy(androidApps = fields.androidApps + pkg))
                picking = false
            },
            onDismiss = { picking = false },
            loading = apps == null,
        )
    }
}

/** The installed launcher apps, read off the main thread; null until loaded. */
@Composable
private fun rememberInstalledApps(): List<InstalledApp>? {
    val app = LocalContext.current.applicationContext as PassHolderApp
    var apps by remember { mutableStateOf<List<InstalledApp>?>(null) }
    // A failing PackageManager must not leave the picker on "Ładuję…".
    LaunchedEffect(Unit) { apps = withContext(Dispatchers.IO) { runCatching { app.installedApps.list() }.getOrDefault(emptyList()) } }
    return apps
}
