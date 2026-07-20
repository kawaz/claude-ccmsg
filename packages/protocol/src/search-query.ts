export interface SearchQueryOptions {
  caseSensitive: boolean;
  regex: boolean;
}

export interface SearchQueryPattern {
  readonly text: string;
  readonly source: string;
  readonly flags: string;
  readonly error: string | null;
}

export interface ParsedSearchQueryPatterns {
  readonly groups: SearchQueryPattern[][];
  readonly hasError: boolean;
}

function plainLinePatterns(line: string, flags: string): SearchQueryPattern[] {
  return [...line.matchAll(/("[^"]*"|\S+)/gv)].flatMap((match) => {
    const word = match[0]!.replace(/^"|"$/g, "");
    const parts = word.split(/\s+/v).filter(Boolean);
    if (parts.length === 0) return [];
    return [
      {
        text: parts.join(" "),
        source: parts.map((part) => RegExp.escape(part)).join("\\s+"),
        flags,
        error: null,
      },
    ];
  });
}

/** Parses a query into an outer AND list of inner OR pattern lists. */
export function parseSearchQueryPatterns(
  query: string,
  options: SearchQueryOptions,
): ParsedSearchQueryPatterns {
  const flags = `v${options.caseSensitive ? "" : "i"}`;
  const groups: SearchQueryPattern[][] = [];
  for (const line of query.split(/[\r\n]/v)) {
    if (!options.regex) {
      const patterns = plainLinePatterns(line, flags);
      if (patterns.length > 0) groups.push(patterns);
      continue;
    }
    if (line.length === 0) continue;
    let error: string | null = null;
    try {
      new RegExp(line, flags);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    groups.push([{ text: line, source: line, flags, error }]);
  }
  return { groups, hasError: groups.some((group) => group.some((pattern) => pattern.error)) };
}
