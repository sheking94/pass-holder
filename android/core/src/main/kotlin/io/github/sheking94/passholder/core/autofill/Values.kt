package io.github.sheking94.passholder.core.autofill

import io.github.sheking94.passholder.core.p2p.CardFields
import io.github.sheking94.passholder.core.p2p.ContactFields
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.LoginFields
import java.time.DateTimeException
import java.time.LocalDate
import java.util.Locale

/** Port of core/src/autofill/values.ts. */
sealed interface FillPlan {
    data class Login(val username: String, val password: String) : FillPlan
    data class Card(val holder: String, val number: String, val expiry: String, val cvc: String) : FillPlan
    data class Contact(
        val firstName: String,
        val lastName: String,
        val email: String,
        val tel: String,
        val street: String,
        val postalCode: String,
        val city: String,
        val country: String,
        val bday: String,
    ) : FillPlan
}

// [0-9], not \\d: on Android (ICU) \\d also matches non-ASCII digits.
private val BIRTH_DATE = Regex("^([0-9]{4})-([0-9]{2})-([0-9]{2})$")

/** Stored birth dates are RRRR-MM-DD; anything that is not a real calendar date is dropped. */
private fun validBirthDate(s: String): String {
    val m = BIRTH_DATE.matchEntire(s) ?: return ""
    return try {
        LocalDate.of(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt())
        s
    } catch (_: DateTimeException) {
        ""
    }
}

fun planFor(entry: EntryContentV3): FillPlan? = when (val f = entry.fields) {
    is LoginFields -> FillPlan.Login(f.username, f.password)

    is CardFields -> FillPlan.Card(f.holder, f.number, f.expiry, f.cvc)

    is ContactFields -> {
        val a = f.addresses.firstOrNull()
        FillPlan.Contact(
            f.firstName, f.lastName,
            f.emails.firstOrNull()?.value ?: "", f.phones.firstOrNull()?.value ?: "",
            a?.street ?: "", a?.postalCode ?: "", a?.city ?: "", a?.country ?: "",
            validBirthDate(f.birthDate),
        )
    }

    else -> null
}

/** First candidate that matches a select option by value or text (case-insensitive); returns the option value. */
private fun selectOption(options: List<FieldOption>, candidates: List<String>): String? {
    for (candidate in candidates) {
        val hit = options.firstOrNull {
            it.value.lowercase(Locale.ROOT) == candidate.lowercase(Locale.ROOT) ||
                it.text.lowercase(Locale.ROOT) == candidate.lowercase(Locale.ROOT)
        }
        if (hit != null) return hit.value
    }
    return null
}

private val EXPIRY = Regex("^(0[1-9]|1[0-2])/(\\d{2})$")

private fun candidates(plan: FillPlan, kind: FieldKind, field: FieldDescriptor, hasUsernameField: Boolean): List<String> {
    when (plan) {
        is FillPlan.Login -> return when {
            kind == FieldKind.USERNAME -> listOf(plan.username)
            kind == FieldKind.PASSWORD -> listOf(plan.password)
            kind == FieldKind.EMAIL && !hasUsernameField -> listOf(plan.username)
            else -> emptyList()
        }

        is FillPlan.Card -> {
            val m = EXPIRY.matchEntire(plan.expiry)
            val month = m?.groupValues?.get(1)
            val year2 = m?.groupValues?.get(2)
            val isSelect = field.type.lowercase(Locale.ROOT) == "select"
            return when (kind) {
                FieldKind.CC_NAME -> listOf(plan.holder)

                FieldKind.CC_NUMBER -> listOf(plan.number.replace(Regex("\\s+"), ""))

                FieldKind.CC_CSC -> listOf(plan.cvc)

                FieldKind.CC_EXP -> {
                    if (month == null || year2 == null) return emptyList()
                    val long = (field.maxLength ?: 0) >= 7 ||
                        Regex("rrrr|yyyy", RegexOption.IGNORE_CASE).containsMatchIn(field.placeholder)
                    listOf("$month/${if (long) "20" else ""}$year2")
                }

                FieldKind.CC_EXP_MONTH -> {
                    if (month == null) return emptyList()
                    if (isSelect) listOf(month, month.toInt().toString()) else listOf(month)
                }

                FieldKind.CC_EXP_YEAR -> {
                    if (year2 == null) return emptyList()
                    val full = "20$year2"
                    if (isSelect) listOf(full, year2) else listOf(if (field.maxLength == 2) year2 else full)
                }

                else -> emptyList()
            }
        }

        is FillPlan.Contact -> return when (kind) {
            FieldKind.GIVEN_NAME -> listOf(plan.firstName)
            FieldKind.FAMILY_NAME -> listOf(plan.lastName)
            FieldKind.FULL_NAME -> listOf(listOf(plan.firstName, plan.lastName).filter { it != "" }.joinToString(" "))
            FieldKind.EMAIL -> listOf(plan.email)
            FieldKind.TEL -> listOf(plan.tel)
            FieldKind.STREET -> listOf(plan.street)
            FieldKind.POSTAL_CODE -> listOf(plan.postalCode)
            FieldKind.CITY -> listOf(plan.city)
            FieldKind.COUNTRY -> listOf(plan.country)
            FieldKind.BDAY -> listOf(plan.bday)
            else -> emptyList()
        }
    }
}

/** The text to type into a field, or null to leave the field untouched. */
fun fillValue(plan: FillPlan, kind: FieldKind, field: FieldDescriptor, hasUsernameField: Boolean): String? {
    val wanted = candidates(plan, kind, field, hasUsernameField).filter { it != "" }
    if (wanted.isEmpty()) return null
    if (field.type.lowercase(Locale.ROOT) == "select") return selectOption(field.options ?: emptyList(), wanted)
    return wanted[0]
}
