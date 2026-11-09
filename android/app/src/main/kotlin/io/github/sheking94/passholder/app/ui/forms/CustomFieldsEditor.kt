package io.github.sheking94.passholder.app.ui.forms

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.ui.PlainField
import io.github.sheking94.passholder.app.ui.SecretField
import io.github.sheking94.passholder.core.p2p.CustomField

/** "Własne pola": label, value and "ukryte"; a hidden value is masked and copied as a secret. */
@Composable
fun CustomFieldsEditor(items: List<CustomField>, onChange: (List<CustomField>) -> Unit, vm: AppViewModel) {
    ListEditor(
        title = "Własne pola",
        items = items,
        onChange = onChange,
        addLabel = "Dodaj pole",
        empty = { CustomField("", "", false) },
    ) { field, update ->
        // Per row (ListEditor keys the rows): a shown value is masked again when "ukryte" is switched on.
        var revealed by remember { mutableStateOf(false) }
        val copyLabel = field.label.ifBlank { "Wartość pola" }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            PlainField(field.label, { update(field.copy(label = it)) }, "Etykieta")
            if (field.hidden) {
                SecretField(
                    field.value,
                    { update(field.copy(value = it)) },
                    "Wartość",
                    onCopy = { vm.copy(copyLabel, field.value, sensitive = true) },
                    revealed = revealed,
                    onRevealedChange = { revealed = it },
                )
            } else {
                PlainField(field.value, { update(field.copy(value = it)) }, "Wartość", onCopy = { vm.copy(copyLabel, field.value, sensitive = false) })
            }
            Row(
                Modifier.toggleable(field.hidden, role = Role.Checkbox) { hidden ->
                    revealed = false
                    update(field.copy(hidden = hidden))
                },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(checked = field.hidden, onCheckedChange = null)
                Text("ukryte")
            }
        }
    }
}
