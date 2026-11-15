import { PSL_RULES } from "./psl-rules.ts";

interface Rules {
  exact: Set<string>;
  /** "*.ck" stored as "ck" */
  wildcard: Set<string>;
  /** "!www.ck" stored as "www.ck" */
  exception: Set<string>;
}

let rules: Rules | undefined;

function load(): Rules {
  if (rules) return rules;
  const loaded: Rules = { exact: new Set(), wildcard: new Set(), exception: new Set() };
  for (const rule of PSL_RULES.split("\n")) {
    if (rule.startsWith("!")) loaded.exception.add(rule.slice(1));
    else if (rule.startsWith("*.")) loaded.wildcard.add(rule.slice(2));
    else loaded.exact.add(rule);
  }
  rules = loaded;
  return loaded;
}

/**
 * Public suffix of a lowercase ASCII host (Public Suffix List algorithm, unknown TLDs by the default rule "*"):
 * `example.co.uk` -> `co.uk`, `user.github.io` -> `github.io`.
 */
export function publicSuffix(host: string): string {
  const { exact, wildcard, exception } = load();
  const labels = host.split(".");
  // Longest candidate first: the longest matching rule wins, an exception rule cuts its first label.
  for (let i = 0; i < labels.length; i++) {
    const name = labels.slice(i).join(".");
    if (exception.has(name)) return labels.slice(i + 1).join(".");
    if (exact.has(name)) return name;
    if (i + 1 < labels.length && wildcard.has(labels.slice(i + 1).join("."))) return name;
  }
  return labels[labels.length - 1]!;
}

/** The registrable domain (public suffix plus one label), undefined when the host is itself a public suffix. */
export function registrableDomain(host: string): string | undefined {
  const suffix = publicSuffix(host);
  if (host === suffix) return undefined;
  const labels = host.slice(0, host.length - suffix.length - 1).split(".");
  return `${labels[labels.length - 1]}.${suffix}`;
}
