package io.github.sheking94.passholder.app.ui.forms

import androidx.compose.runtime.Composable
import androidx.compose.ui.text.input.KeyboardType
import io.github.sheking94.passholder.app.ui.EntryActions
import io.github.sheking94.passholder.app.ui.PlainField
import io.github.sheking94.passholder.app.ui.SecretField
import io.github.sheking94.passholder.core.p2p.CardFields

/** Card section: holder, number, expiry, CVC and PIN (number, CVC and PIN are masked). */
@Composable
fun CardForm(fields: CardFields, onChange: (CardFields) -> Unit, entries: EntryActions) {
    PlainField(fields.holder, { onChange(fields.copy(holder = it)) }, "Posiadacz")
    SecretField(
        fields.number,
        { onChange(fields.copy(number = it)) },
        "Numer",
        onCopy = { entries.copySecret("numer karty", fields.number) },
        monospace = true,
        keyboardType = KeyboardType.Number,
    )
    PlainField(fields.expiry, { onChange(fields.copy(expiry = it)) }, "Ważność", placeholder = "MM/RR")
    SecretField(
        fields.cvc,
        { onChange(fields.copy(cvc = it)) },
        "CVC",
        onCopy = { entries.copySecret("CVC", fields.cvc) },
        keyboardType = KeyboardType.NumberPassword,
    )
    SecretField(
        fields.pin,
        { onChange(fields.copy(pin = it)) },
        "PIN",
        onCopy = { entries.copySecret("PIN", fields.pin) },
        keyboardType = KeyboardType.NumberPassword,
    )
}
