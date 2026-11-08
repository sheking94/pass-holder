package io.github.sheking94.passholder.app.ui.forms

import androidx.compose.runtime.Composable
import androidx.compose.ui.text.input.KeyboardType
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.ui.PlainField
import io.github.sheking94.passholder.app.ui.SecretField
import io.github.sheking94.passholder.core.p2p.CardFields

/** Card section: holder, number, expiry, CVC and PIN (number, CVC and PIN are masked). */
@Composable
fun CardForm(fields: CardFields, onChange: (CardFields) -> Unit, vm: AppViewModel) {
    PlainField(fields.holder, { onChange(fields.copy(holder = it)) }, "Posiadacz")
    SecretField(
        fields.number,
        { onChange(fields.copy(number = it)) },
        "Numer",
        onCopy = { vm.copy("numer karty", fields.number, sensitive = true) },
        monospace = true,
        keyboardType = KeyboardType.Number,
    )
    PlainField(fields.expiry, { onChange(fields.copy(expiry = it)) }, "Ważność", placeholder = "MM/RR")
    SecretField(
        fields.cvc,
        { onChange(fields.copy(cvc = it)) },
        "CVC",
        onCopy = { vm.copy("CVC", fields.cvc, sensitive = true) },
        keyboardType = KeyboardType.NumberPassword,
    )
    SecretField(
        fields.pin,
        { onChange(fields.copy(pin = it)) },
        "PIN",
        onCopy = { vm.copy("PIN", fields.pin, sensitive = true) },
        keyboardType = KeyboardType.NumberPassword,
    )
}
