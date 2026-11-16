package io.github.sheking94.passholder.app.ui.forms

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.entries.DOCUMENT_KIND_LABELS
import io.github.sheking94.passholder.app.ui.PlainField
import io.github.sheking94.passholder.core.p2p.DocumentFields

/** Document section: kind (dropdown), number, full name, issue and expiry dates, issuer. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DocumentForm(fields: DocumentFields, onChange: (DocumentFields) -> Unit, vm: AppViewModel) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded, { expanded = it }) {
        OutlinedTextField(
            value = DOCUMENT_KIND_LABELS[fields.kind].orEmpty(),
            onValueChange = {},
            readOnly = true,
            label = { Text("Rodzaj") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded, { expanded = false }) {
            for ((kind, label) in DOCUMENT_KIND_LABELS) {
                DropdownMenuItem(text = { Text(label) }, onClick = {
                    onChange(fields.copy(kind = kind))
                    expanded = false
                })
            }
        }
    }
    PlainField(fields.number, { onChange(fields.copy(number = it)) }, "Numer", monospace = true)
    PlainField(fields.fullName, { onChange(fields.copy(fullName = it)) }, "Imię i nazwisko")
    PlainField(fields.issueDate, { onChange(fields.copy(issueDate = it)) }, "Data wydania", placeholder = "RRRR-MM-DD")
    PlainField(fields.expiryDate, { onChange(fields.copy(expiryDate = it)) }, "Data ważności", placeholder = "RRRR-MM-DD")
    PlainField(fields.issuer, { onChange(fields.copy(issuer = it)) }, "Wystawca")
}
