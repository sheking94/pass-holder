/** The password generator fieldset; its settings are remembered in STORAGE_KEYS.generator. */
import {
  CHARACTER_GROUPS,
  DEFAULT_GENERATOR_OPTIONS,
  MAX_LENGTH,
  MIN_LENGTH,
  generatePassword,
  type CharacterGroup,
  type GeneratorOptions,
} from "@passholder/core";
import { STORAGE_KEYS } from "../../storage.ts";
import { h, setStatus } from "../../ui/dom.ts";
import { local } from "../../ui/state.ts";

const GROUP_LABELS: Record<CharacterGroup, string> = {
  lowercase: "małe litery",
  uppercase: "wielkie litery",
  digits: "cyfry",
  symbols: "symbole",
};

async function loadGeneratorOptions(): Promise<GeneratorOptions> {
  return (await local.get<GeneratorOptions>(STORAGE_KEYS.generator)) ?? DEFAULT_GENERATOR_OPTIONS;
}

/** „Generator haseł”: „Generuj” hands a new password to onGenerated and remembers the settings. */
export async function passwordGenerator(
  status: HTMLElement,
  onGenerated: (password: string) => void,
): Promise<HTMLElement> {
  const options = await loadGeneratorOptions();
  const length = h("input", {
    type: "range",
    min: MIN_LENGTH,
    max: MAX_LENGTH,
    value: options.length,
  });
  const lengthLabel = h("span", { class: "mono" }, String(options.length));
  length.addEventListener("input", () => (lengthLabel.textContent = length.value));
  const groupBoxes = (Object.keys(CHARACTER_GROUPS) as CharacterGroup[]).map((group) => ({
    group,
    box: h("input", { type: "checkbox", checked: options.groups.includes(group) }),
  }));

  const generate = async () => {
    const chosen: GeneratorOptions = {
      length: Number(length.value),
      groups: groupBoxes.filter((g) => g.box.checked).map((g) => g.group),
    };
    if (chosen.groups.length === 0)
      return setStatus(status, "Wybierz co najmniej jedną grupę znaków", true);
    onGenerated(generatePassword(chosen));
    await local.set(STORAGE_KEYS.generator, chosen);
    setStatus(status, "");
  };

  return h(
    "fieldset",
    {},
    h("legend", {}, "Generator haseł"),
    h("div", { class: "row" }, h("span", {}, "Długość"), length, lengthLabel),
    h(
      "div",
      { class: "groups" },
      ...groupBoxes.map(({ group, box }) => h("label", {}, box, GROUP_LABELS[group])),
    ),
    h("div", { class: "actions" }, h("button", { type: "button", onclick: generate }, "Generuj")),
  );
}
