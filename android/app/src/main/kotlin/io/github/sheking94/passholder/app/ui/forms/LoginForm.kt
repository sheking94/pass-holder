package io.github.sheking94.passholder.app.ui.forms

import androidx.compose.runtime.Composable
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
    PlainField(fields.username, { onChange(fields.copy(username = it)) }, "Login", onCopy = { vm.copy("Login", fields.username, sensitive = false) })
    SecretField(
        fields.password,
        { onChange(fields.copy(password = it)) },
        "Hasło",
        onCopy = { vm.copy("Hasło", fields.password, sensitive = true) },
        monospace = true,
        revealed = passwordShown,
        onRevealedChange = { passwordShown = it },
    )
    GeneratorCard(vm) {
        onChange(fields.copy(password = it))
        passwordShown = true
    }
    SecretField(fields.totp, { onChange(fields.copy(totp = it)) }, "TOTP", onCopy = { vm.copy("TOTP", fields.totp, sensitive = true) }, monospace = true)
    ListEditor("Adresy stron", fields.urls, { onChange(fields.copy(urls = it)) }, "Dodaj adres", { "" }) { url, update ->
        PlainField(url, update, "Adres strony", keyboardType = KeyboardType.Uri, placeholder = "https://")
    }
    // Typed by hand for now; picking an installed app comes later.
    ListEditor("Aplikacje Androida", fields.androidApps, { onChange(fields.copy(androidApps = it)) }, "Dodaj aplikację", { "" }) { app, update ->
        PlainField(app, update, "Nazwa pakietu", placeholder = "np. pl.mbank")
    }
}
