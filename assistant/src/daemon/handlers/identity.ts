/**
 * Returns true when the value is a template placeholder that should be treated
 * as empty/unset. Placeholders follow the pattern `_(…)_`, e.g.
 * `_(not yet chosen)_` or `_(not yet established)_`.
 */
export function isTemplatePlaceholder(value: string): boolean {
  return value.startsWith("_(") && value.endsWith(")_");
}

export interface IdentityFields {
  name: string;
  role: string;
  personality: string;
  emoji: string;
  home: string;
}

export type EditableIdentityFields = Pick<
  IdentityFields,
  "name" | "role" | "personality"
>;

export type IdentityFieldsPatch = Partial<EditableIdentityFields>;

const EDITABLE_IDENTITY_LABELS: Record<keyof EditableIdentityFields, string> = {
  name: "Name",
  role: "Role",
  personality: "Personality",
};

interface CanonicalMetadataBlock {
  endIndex: number;
  insertionIndex: number;
  lineIndexes: number[];
}

const IDENTITY_HEADING_PATTERN = /^#[ \t]+identity(?:\.md)?[ \t]*$/i;
const METADATA_ROW_PATTERN =
  /^- \*\*([A-Za-z][A-Za-z0-9 _-]*):\*\*(?:[ \t]*(.*))?$/;
const HTML_COMMENT_START_PATTERN = /^ {0,3}<!--/;

function consumeHtmlComment(
  lines: string[],
  startIndex: number,
): { closed: boolean; nextIndex: number } {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (lines[index]?.includes("-->")) {
      return { closed: true, nextIndex: index + 1 };
    }
  }
  return { closed: false, nextIndex: lines.length };
}

function scanCanonicalMetadataBlock(lines: string[]): CanonicalMetadataBlock {
  let index = 0;
  let insertionIndex = 0;
  let sawIdentityHeading = false;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim() === "" || line.startsWith("_")) {
      index += 1;
      insertionIndex = index;
      continue;
    }

    if (HTML_COMMENT_START_PATTERN.test(line)) {
      const commentStart = index;
      const comment = consumeHtmlComment(lines, index);
      if (!comment.closed) {
        return {
          endIndex: commentStart,
          insertionIndex: commentStart,
          lineIndexes: [],
        };
      }
      index = comment.nextIndex;
      insertionIndex = index;
      continue;
    }

    if (!sawIdentityHeading && IDENTITY_HEADING_PATTERN.test(line)) {
      sawIdentityHeading = true;
      index += 1;
      insertionIndex = index;
      continue;
    }

    break;
  }

  const lineIndexes: number[] = [];
  let cursor = index;
  let endIndex = index;

  while (cursor < lines.length) {
    if (METADATA_ROW_PATTERN.test(lines[cursor] ?? "")) {
      lineIndexes.push(cursor);
      endIndex = cursor + 1;
      cursor += 1;
      continue;
    }

    if ((lines[cursor] ?? "").trim() === "") {
      let next = cursor + 1;
      while (next < lines.length && (lines[next] ?? "").trim() === "") {
        next += 1;
      }
      if (next < lines.length && METADATA_ROW_PATTERN.test(lines[next] ?? "")) {
        cursor = next;
        continue;
      }
    }

    break;
  }

  return {
    endIndex,
    insertionIndex: lineIndexes.length > 0 ? endIndex : insertionIndex,
    lineIndexes,
  };
}

/** Parse the core identity fields from IDENTITY.md content. */
export function parseIdentityFields(content: string): IdentityFields {
  const fields: Record<string, string> = {};
  const normalized = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const lines = normalized.split(/\r?\n/);
  const { lineIndexes } = scanCanonicalMetadataBlock(lines);
  let canonicalPersonality: string | null = null;
  let legacyVibe: string | null = null;

  for (const index of lineIndexes) {
    const line = lines[index] ?? "";
    const match = METADATA_ROW_PATTERN.exec(line);
    if (!match) continue;
    const label = match[1]!.toLowerCase();
    const value = match[2]?.trim() || null;
    if (!value || isTemplatePlaceholder(value)) continue;

    if (label === "name") fields.name = value;
    else if (label === "role") fields.role = value;
    else if (label === "personality") canonicalPersonality = value;
    else if (label === "vibe") legacyVibe = value;
    else if (label === "emoji") fields.emoji = value;
    else if (label === "home") fields.home = value;
  }
  return {
    name: fields.name ?? "",
    role: fields.role ?? "",
    personality: canonicalPersonality ?? legacyVibe ?? "",
    emoji: fields.emoji ?? "",
    home: fields.home ?? "",
  };
}

/**
 * Update canonical identity metadata while preserving unrelated sections.
 *
 * Existing duplicate field rows in the top metadata block are normalized to
 * the same value. Later sections and fenced examples remain untouched.
 * Missing fields are inserted at the end of the canonical metadata block.
 */
export function updateIdentityFields(
  content: string,
  patch: IdentityFieldsPatch,
): string {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const normalized = bom ? content.slice(1) : content;
  const newline = normalized.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = normalized.endsWith("\n");
  const lines = normalized === "" ? [] : normalized.split(/\r?\n/);
  if (hadTrailingNewline) {
    lines.pop();
  }

  const block = scanCanonicalMetadataBlock(lines);
  const missingRows: string[] = [];

  for (const [field, value] of Object.entries(patch) as Array<
    [keyof EditableIdentityFields, string]
  >) {
    const label = EDITABLE_IDENTITY_LABELS[field];
    let matched = false;

    for (const index of block.lineIndexes) {
      const row = METADATA_ROW_PATTERN.exec(lines[index] ?? "");
      if (row?.[1]?.toLowerCase() !== field) continue;
      lines[index] = `- **${label}:** ${value}`;
      matched = true;
    }

    if (!matched && field === "personality") {
      for (const index of block.lineIndexes) {
        const row = METADATA_ROW_PATTERN.exec(lines[index] ?? "");
        if (row?.[1]?.toLowerCase() !== "vibe") continue;
        lines[index] = `- **Personality:** ${value}`;
        matched = true;
      }
    }

    if (!matched) {
      missingRows.push(`- **${label}:** ${value}`);
    }
  }

  if (missingRows.length > 0) {
    const insertionIndex = block.insertionIndex;
    const insertedLines: string[] = [];
    if (insertionIndex > 0 && lines[insertionIndex - 1]?.trim() !== "") {
      insertedLines.push("");
    }
    insertedLines.push(...missingRows);
    if (insertionIndex < lines.length && lines[insertionIndex]?.trim() !== "") {
      insertedLines.push("");
    }
    lines.splice(insertionIndex, 0, ...insertedLines);
  }

  return `${bom}${lines.join(newline)}${hadTrailingNewline ? newline : ""}`;
}
