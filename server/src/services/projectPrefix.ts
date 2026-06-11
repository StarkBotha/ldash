/**
 * Derive a ticket-key prefix from a project name (e.g. "dungeon sweeper" → "DS",
 * "dungeonsweeper" → "DUN"). Prefixes are immutable once assigned — renaming a
 * project does not change existing keys.
 */
export function derivePrefix(name: string, taken: Set<string>): string {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .map((w) => w.replace(/[^A-Z]/g, ''))
    .filter((w) => w.length > 0);

  let base: string;
  if (words.length >= 2) {
    base = words.slice(0, 4).map((w) => w[0]).join('');
  } else if (words.length === 1) {
    base = words[0].slice(0, 3);
  } else {
    base = 'PRJ';
  }
  if (base.length < 2) {
    base = (base + 'X').slice(0, 2);
  }

  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
