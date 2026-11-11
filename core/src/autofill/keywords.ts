export type FieldKind =
  | "username" | "password" | "newPassword"
  | "ccName" | "ccNumber" | "ccExp" | "ccExpMonth" | "ccExpYear" | "ccCsc"
  | "givenName" | "familyName" | "fullName" | "email" | "tel"
  | "street" | "postalCode" | "city" | "country" | "bday";

/** Lowercase, strip diacritics (NFD), and map the stroked l (not decomposable) to plain l. */
export function normalizeText(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/ł/g, "l");
}

/**
 * Rule 1: autocomplete tokens (HTML) and Android autofill hints. Keys are lowercase;
 * lookups lowercase the token, so camelCase Android constants match too.
 */
export const AUTOCOMPLETE_TOKENS: Readonly<Record<string, FieldKind | "skip">> = {
  username: "username",
  email: "email",
  emailaddress: "email",
  "current-password": "password",
  password: "password",
  "new-password": "newPassword",
  newpassword: "newPassword",
  "cc-name": "ccName",
  "cc-number": "ccNumber",
  creditcardnumber: "ccNumber",
  "cc-exp": "ccExp",
  creditcardexpirationdate: "ccExp",
  "cc-exp-month": "ccExpMonth",
  creditcardexpirationmonth: "ccExpMonth",
  "cc-exp-year": "ccExpYear",
  creditcardexpirationyear: "ccExpYear",
  "cc-csc": "ccCsc",
  creditcardsecuritycode: "ccCsc",
  "given-name": "givenName",
  persongivenname: "givenName",
  "family-name": "familyName",
  personfamilyname: "familyName",
  name: "fullName",
  personname: "fullName",
  tel: "tel",
  phone: "tel",
  phonenumber: "tel",
  "street-address": "street",
  "address-line1": "street",
  // Extra address lines must not receive the street again.
  "address-line2": "skip",
  "address-line3": "skip",
  postaladdress: "street",
  "postal-code": "postalCode",
  postalcode: "postalCode",
  "address-level2": "city",
  country: "country",
  "country-name": "country",
  bday: "bday",
  birthdatefull: "bday",
};

/**
 * Rule 3: keyword patterns matched against normalizeText(name id label placeholder).
 * Order matters: the first match wins. newPassword only applies to type=password fields
 * (enforced in classifyField).
 */
export const NEW_PASSWORD_PATTERN = /powtorz|potwierdz|confirm|repeat|new.?pass|nowe.?haslo/;

/**
 * Names that look like a known field but are not (checked before KEYWORDS, never for type=password):
 * address lines 2 and 3, and password hints.
 */
export const SKIP_PATTERN = new RegExp([
  "(address|adres)[\\s_()-]*(line|linia)?[\\s_()-]*[23]\\b",
  "(^|[^a-z])(line|linia)[\\s_-]*[23]\\b",
  "(pass\\w*|haslo)[\\s_-]*(hint|podpowiedz)",
  "(hint|podpowiedz)[\\s_-]*(pass\\w*|haslo)",
].join("|"));

export const KEYWORDS: readonly { kind: FieldKind; pattern: RegExp }[] = [
  { kind: "newPassword", pattern: NEW_PASSWORD_PATTERN },
  { kind: "ccExpMonth", pattern: /exp\w*.?month|exp.?mm|cc.?month|miesiac.?waznosci/ },
  { kind: "ccExpYear", pattern: /exp\w*.?year|exp.?yy|cc.?year|rok.?waznosci/ },
  { kind: "ccExp", pattern: /cc.?exp|expir|valid.?thru|data.?waznosci|waznosc|mm.?[/-]?.?yy/ },
  { kind: "ccCsc", pattern: /cvc|cvv|csc|security.?code|kod.?zabezp/ },
  { kind: "ccNumber", pattern: /card.?n(um|o)|numer.?karty|cc.?num/ },
  { kind: "ccName", pattern: /card.?holder|cc.?name|name.?on.?card|wlasciciel.?karty|imie.?i.?nazwisko.?na.?karcie/ },
  { kind: "email", pattern: /e-?mail/ },
  // password before username: login_password / user_password (show-password toggles) are passwords.
  { kind: "password", pattern: /passw|haslo/ },
  { kind: "username", pattern: /login|user|uzytkownik/ },
  { kind: "fullName", pattern: /full.?name|imie.?i.?nazwisko|nazwisko.?i.?imie/ },
  { kind: "givenName", pattern: /first.?name|given|fname|forename|imie/ },
  { kind: "familyName", pattern: /last.?name|family|surname|lname|nazwisko/ },
  { kind: "tel", pattern: /phone|telefon|mobile|komorka|\btel\b/ },
  { kind: "postalCode", pattern: /kod.?pocztowy|zip|postal|post.?code/ },
  { kind: "street", pattern: /street|address|adres|ulica/ },
  { kind: "city", pattern: /\bcity\b|\btown\b|miejscowosc|miasto/ },
  { kind: "country", pattern: /country|kraj|panstwo/ },
  { kind: "bday", pattern: /birth|bday|urodzenia|urodzin/ },
  { kind: "fullName", pattern: /(^|\s)name(\s|$)/ },
];
