import type { EntryContentV3 } from "../p2p/entry.ts";
import type { FieldDescriptor } from "./fields.ts";
import type { FieldKind } from "./keywords.ts";

export type FillPlan =
  | { kind: "login"; username: string; password: string }
  | { kind: "card"; holder: string; number: string; expiry: string; cvc: string }
  | {
      kind: "contact";
      firstName: string; lastName: string; email: string; tel: string;
      street: string; postalCode: string; city: string; country: string; bday: string;
    };

/** Stored birth dates are RRRR-MM-DD; anything that is not a real calendar date is dropped. */
function validBirthDate(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s ? s : "";
}

export function planFor(entry: EntryContentV3): FillPlan | undefined {
  switch (entry.type) {
    case "login":
      return { kind: "login", username: entry.fields.username, password: entry.fields.password };
    case "card": {
      const f = entry.fields;
      return { kind: "card", holder: f.holder, number: f.number, expiry: f.expiry, cvc: f.cvc };
    }
    case "contact": {
      const f = entry.fields;
      const a = f.addresses[0];
      return {
        kind: "contact",
        firstName: f.firstName, lastName: f.lastName,
        email: f.emails[0]?.value ?? "", tel: f.phones[0]?.value ?? "",
        street: a?.street ?? "", postalCode: a?.postalCode ?? "", city: a?.city ?? "", country: a?.country ?? "",
        bday: validBirthDate(f.birthDate),
      };
    }
    default:
      return undefined;
  }
}

/** First candidate that matches a <select> option by value or text (case-insensitive); returns the option value. */
function selectOption(options: { value: string; text: string }[], candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const c = candidate.toLowerCase();
    const hit = options.find((o) => o.value.toLowerCase() === c || o.text.toLowerCase() === c);
    if (hit) return hit.value;
  }
  return undefined;
}

/** Splits "MM/RR"; undefined when the expiry is not in that format. */
function parseExpiry(expiry: string): { month: string; year2: string } | undefined {
  const m = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(expiry);
  return m ? { month: m[1]!, year2: m[2]! } : undefined;
}

/** Value text candidates for a field kind, most preferred first. */
function candidates(plan: FillPlan, kind: FieldKind, field: FieldDescriptor, form: { hasUsernameField: boolean }): string[] {
  if (plan.kind === "login") {
    if (kind === "username") return [plan.username];
    if (kind === "password") return [plan.password];
    if (kind === "email" && !form.hasUsernameField) return [plan.username];
    return [];
  }
  if (plan.kind === "card") {
    const exp = parseExpiry(plan.expiry);
    const isSelect = field.type.toLowerCase() === "select";
    switch (kind) {
      case "ccName": return [plan.holder];
      case "ccNumber": return [plan.number.replace(/\s+/g, "")];
      case "ccCsc": return [plan.cvc];
      case "ccExp": {
        if (!exp) return [];
        const long = (field.maxLength ?? 0) >= 7 || /rrrr|yyyy/i.test(field.placeholder);
        return [`${exp.month}/${long ? "20" : ""}${exp.year2}`];
      }
      case "ccExpMonth":
        if (!exp) return [];
        return isSelect ? [exp.month, String(Number(exp.month))] : [exp.month];
      case "ccExpYear": {
        if (!exp) return [];
        const full = `20${exp.year2}`;
        if (isSelect) return [full, exp.year2];
        return [field.maxLength === 2 ? exp.year2 : full];
      }
      default: return [];
    }
  }
  switch (kind) {
    case "givenName": return [plan.firstName];
    case "familyName": return [plan.lastName];
    case "fullName": return [[plan.firstName, plan.lastName].filter((p) => p !== "").join(" ")];
    case "email": return [plan.email];
    case "tel": return [plan.tel];
    case "street": return [plan.street];
    case "postalCode": return [plan.postalCode];
    case "city": return [plan.city];
    case "country": return [plan.country];
    case "bday": return [plan.bday];
    default: return [];
  }
}

/** The text to type into a field, or undefined to leave the field untouched. */
export function fillValue(
  plan: FillPlan, kind: FieldKind, field: FieldDescriptor, form: { hasUsernameField: boolean },
): string | undefined {
  const wanted = candidates(plan, kind, field, form).filter((v) => v !== "");
  if (wanted.length === 0) return undefined;
  if (field.type.toLowerCase() === "select") return selectOption(field.options ?? [], wanted);
  return wanted[0];
}
