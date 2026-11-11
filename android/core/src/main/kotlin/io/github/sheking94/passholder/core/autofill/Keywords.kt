package io.github.sheking94.passholder.core.autofill

import java.text.Normalizer
import java.util.Locale

/** Port of core/src/autofill/keywords.ts. */
enum class FieldKind(val json: String) {
    USERNAME("username"), PASSWORD("password"), NEW_PASSWORD("newPassword"),
    CC_NAME("ccName"), CC_NUMBER("ccNumber"), CC_EXP("ccExp"), CC_EXP_MONTH("ccExpMonth"),
    CC_EXP_YEAR("ccExpYear"), CC_CSC("ccCsc"),
    GIVEN_NAME("givenName"), FAMILY_NAME("familyName"), FULL_NAME("fullName"), EMAIL("email"), TEL("tel"),
    STREET("street"), POSTAL_CODE("postalCode"), CITY("city"), COUNTRY("country"), BDAY("bday");

    companion object {
        fun fromJson(s: String): FieldKind = entries.first { it.json == s }
    }
}

private val COMBINING_MARKS = Regex("\\p{M}")

/** Lowercase, strip diacritics (NFD), and map the stroked l (not decomposable) to plain l. */
fun normalizeText(s: String): String =
    COMBINING_MARKS.replace(Normalizer.normalize(s.lowercase(Locale.ROOT), Normalizer.Form.NFD), "").replace('ł', 'l')

/** Rule 1: autocomplete tokens and Android autofill hints (lowercase keys). `null` means skip the field. */
val AUTOCOMPLETE_TOKENS: Map<String, FieldKind?> = mapOf(
    "username" to FieldKind.USERNAME,
    "email" to FieldKind.EMAIL,
    "emailaddress" to FieldKind.EMAIL,
    "current-password" to FieldKind.PASSWORD,
    "password" to FieldKind.PASSWORD,
    "new-password" to FieldKind.NEW_PASSWORD,
    "newpassword" to FieldKind.NEW_PASSWORD,
    "cc-name" to FieldKind.CC_NAME,
    "cc-number" to FieldKind.CC_NUMBER,
    "creditcardnumber" to FieldKind.CC_NUMBER,
    "cc-exp" to FieldKind.CC_EXP,
    "creditcardexpirationdate" to FieldKind.CC_EXP,
    "cc-exp-month" to FieldKind.CC_EXP_MONTH,
    "creditcardexpirationmonth" to FieldKind.CC_EXP_MONTH,
    "cc-exp-year" to FieldKind.CC_EXP_YEAR,
    "creditcardexpirationyear" to FieldKind.CC_EXP_YEAR,
    "cc-csc" to FieldKind.CC_CSC,
    "creditcardsecuritycode" to FieldKind.CC_CSC,
    "given-name" to FieldKind.GIVEN_NAME,
    "persongivenname" to FieldKind.GIVEN_NAME,
    "family-name" to FieldKind.FAMILY_NAME,
    "personfamilyname" to FieldKind.FAMILY_NAME,
    "name" to FieldKind.FULL_NAME,
    "personname" to FieldKind.FULL_NAME,
    "tel" to FieldKind.TEL,
    "phone" to FieldKind.TEL,
    "phonenumber" to FieldKind.TEL,
    "street-address" to FieldKind.STREET,
    "address-line1" to FieldKind.STREET,
    // Extra address lines must not receive the street again.
    "address-line2" to null,
    "address-line3" to null,
    "postaladdress" to FieldKind.STREET,
    "postal-code" to FieldKind.POSTAL_CODE,
    "postalcode" to FieldKind.POSTAL_CODE,
    "address-level2" to FieldKind.CITY,
    "country" to FieldKind.COUNTRY,
    "country-name" to FieldKind.COUNTRY,
    "bday" to FieldKind.BDAY,
    "birthdatefull" to FieldKind.BDAY,
)

/** Rule 3: keyword patterns matched against normalizeText(name id label placeholder); first match wins. */
val NEW_PASSWORD_PATTERN = Regex("powtorz|potwierdz|confirm|repeat|new.?pass|nowe.?haslo")

/** Names that look like a known field but are not (address lines 2/3, password hints). */
val SKIP_PATTERN = Regex(
    listOf(
        "(address|adres)[\\s_()-]*(line|linia)?[\\s_()-]*[23]\\b",
        "(^|[^a-z])(line|linia)[\\s_-]*[23]\\b",
        "(pass\\w*|haslo)[\\s_-]*(hint|podpowiedz)",
        "(hint|podpowiedz)[\\s_-]*(pass\\w*|haslo)",
    ).joinToString("|"),
)

val KEYWORDS: List<Pair<FieldKind, Regex>> = listOf(
    FieldKind.NEW_PASSWORD to NEW_PASSWORD_PATTERN,
    FieldKind.CC_EXP_MONTH to Regex("exp\\w*.?month|exp.?mm|cc.?month|miesiac.?waznosci"),
    FieldKind.CC_EXP_YEAR to Regex("exp\\w*.?year|exp.?yy|cc.?year|rok.?waznosci"),
    FieldKind.CC_EXP to Regex("cc.?exp|expir|valid.?thru|data.?waznosci|waznosc|mm.?[/-]?.?yy"),
    FieldKind.CC_CSC to Regex("cvc|cvv|csc|security.?code|kod.?zabezp"),
    FieldKind.CC_NUMBER to Regex("card.?n(um|o)|numer.?karty|cc.?num"),
    FieldKind.CC_NAME to Regex("card.?holder|cc.?name|name.?on.?card|wlasciciel.?karty|imie.?i.?nazwisko.?na.?karcie"),
    FieldKind.EMAIL to Regex("e-?mail"),
    // password before username: login_password / user_password (show-password toggles) are passwords.
    FieldKind.PASSWORD to Regex("passw|haslo"),
    FieldKind.USERNAME to Regex("login|user|uzytkownik"),
    FieldKind.FULL_NAME to Regex("full.?name|imie.?i.?nazwisko|nazwisko.?i.?imie"),
    FieldKind.GIVEN_NAME to Regex("first.?name|given|fname|forename|imie"),
    FieldKind.FAMILY_NAME to Regex("last.?name|family|surname|lname|nazwisko"),
    FieldKind.TEL to Regex("phone|telefon|mobile|komorka|\\btel\\b"),
    FieldKind.POSTAL_CODE to Regex("kod.?pocztowy|zip|postal|post.?code"),
    FieldKind.STREET to Regex("street|address|adres|ulica"),
    FieldKind.CITY to Regex("\\bcity\\b|\\btown\\b|miejscowosc|miasto"),
    FieldKind.COUNTRY to Regex("country|kraj|panstwo"),
    FieldKind.BDAY to Regex("birth|bday|urodzenia|urodzin"),
    FieldKind.FULL_NAME to Regex("(^|\\s)name(\\s|$)"),
)
