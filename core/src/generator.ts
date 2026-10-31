export const CHARACTER_GROUPS = {
  lowercase: "abcdefghijklmnopqrstuvwxyz",
  uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digits: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.<>?/~",
} as const;

export type CharacterGroup = keyof typeof CHARACTER_GROUPS;

export interface GeneratorOptions {
  length: number;
  groups: CharacterGroup[];
}

export const MIN_LENGTH = 4;
export const MAX_LENGTH = 128;

export const DEFAULT_GENERATOR_OPTIONS: GeneratorOptions = {
  length: 20,
  groups: ["lowercase", "uppercase", "digits", "symbols"],
};

/** Uniform random integer in [0, max) using rejection sampling, so no character is more likely than another. */
export function randomIndex(max: number): number {
  if (!Number.isInteger(max) || max <= 0 || max > 2 ** 32) throw new Error("Invalid range");
  const limit = 2 ** 32 - (2 ** 32 % max);
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const value = buf[0]!;
    if (value < limit) return value % max;
  }
}

/** Password with at least one character from every chosen group. */
export function generatePassword(options: GeneratorOptions = DEFAULT_GENERATOR_OPTIONS): string {
  const groups = [...new Set(options.groups)];
  if (groups.length === 0) throw new Error("Choose at least one character group");
  if (!Number.isInteger(options.length) || options.length < MIN_LENGTH || options.length > MAX_LENGTH) {
    throw new Error(`Length must be between ${MIN_LENGTH} and ${MAX_LENGTH}`);
  }
  const pick = (chars: string) => chars[randomIndex(chars.length)]!;
  const all = groups.map((g) => CHARACTER_GROUPS[g]).join("");
  const chars = groups.map((g) => pick(CHARACTER_GROUPS[g]));
  while (chars.length < options.length) chars.push(pick(all));
  // Fisher-Yates, so the guaranteed characters are not always at the start.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}
