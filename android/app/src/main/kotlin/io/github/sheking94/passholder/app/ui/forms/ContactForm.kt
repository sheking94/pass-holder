package io.github.sheking94.passholder.app.ui.forms

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.ui.PlainField
import io.github.sheking94.passholder.core.p2p.ContactFields
import io.github.sheking94.passholder.core.p2p.LabeledValue
import io.github.sheking94.passholder.core.p2p.PostalAddress

/** Contact section: name, birth date, phones, e-mails and postal addresses. */
@Composable
fun ContactForm(fields: ContactFields, onChange: (ContactFields) -> Unit, vm: AppViewModel) {
    PlainField(fields.firstName, { onChange(fields.copy(firstName = it)) }, "Imię")
    PlainField(fields.lastName, { onChange(fields.copy(lastName = it)) }, "Nazwisko")
    PlainField(fields.birthDate, { onChange(fields.copy(birthDate = it)) }, "Data urodzenia", placeholder = "RRRR-MM-DD")
    ListEditor("Telefony", fields.phones, {
        onChange(fields.copy(phones = it))
    }, "Dodaj telefon", { LabeledValue("", "") }) { phone, update ->
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            PlainField(phone.label, { update(phone.copy(label = it)) }, "Etykieta telefonu")
            PlainField(phone.value, { update(phone.copy(value = it)) }, "Telefon", keyboardType = KeyboardType.Phone)
        }
    }
    ListEditor("E-maile", fields.emails, { onChange(fields.copy(emails = it)) }, "Dodaj e-mail", { LabeledValue("", "") }) { mail, update ->
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            PlainField(mail.label, { update(mail.copy(label = it)) }, "Etykieta e-maila")
            PlainField(mail.value, { update(mail.copy(value = it)) }, "E-mail", keyboardType = KeyboardType.Email)
        }
    }
    ListEditor("Adresy", fields.addresses, {
        onChange(fields.copy(addresses = it))
    }, "Dodaj adres", { PostalAddress("", "", "", "", "") }) { a, update ->
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            PlainField(a.label, { update(a.copy(label = it)) }, "Etykieta adresu")
            PlainField(a.street, { update(a.copy(street = it)) }, "Ulica")
            PlainField(a.postalCode, { update(a.copy(postalCode = it)) }, "Kod pocztowy")
            PlainField(a.city, { update(a.copy(city = it)) }, "Miasto")
            PlainField(a.country, { update(a.copy(country = it)) }, "Kraj")
        }
    }
}
