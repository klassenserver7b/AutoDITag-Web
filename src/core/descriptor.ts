import type {
  DescriptorEntry,
  DescriptorIssue,
  DescriptorParseResult,
} from './types';

/**
 * Descriptor file format (identical to the original Python tool):
 *
 *     TRACKNUM_TITLE; ARTIST -- DANCE
 *     01_Voices of Spring; André Rieu -- Wiener Walzer
 */

const LINE_PATTERN = /^(\d+)_(.*);\s(.*)\s--\s(.*)$/;
const LEADING_DIGITS = /^\d+/;

const FORMAT_HINT = 'Format should be: TRACKNUM_TITLE; ARTIST -- DANCE';

/**
 * Number of digits the track numbers of a descriptor file are expected to use.
 *
 * Ported from the Python implementation:
 * `int(math.ceil(math.log10(len(lines) + 1)))`.
 */
export function expectedTrackNumberDigits(lineCount: number): number {
  if (lineCount <= 0) return 1;
  return Math.max(1, Math.ceil(Math.log10(lineCount + 1)));
}

function issue(lineNumber: number, message: string, line: string): DescriptorIssue {
  return { lineNumber, message, line };
}

/**
 * Parses a descriptor file.
 *
 * Unlike the Python tool, which aborts on the first broken line, every
 * problem of the file is collected so the user can fix them all at once.
 * The wording of the messages is kept identical to the original.
 */
export function parseDescriptor(text: string): DescriptorParseResult {
  const issues: DescriptorIssue[] = [];
  const entries: DescriptorEntry[] = [];

  // The original reads with `encoding="utf-8-sig"`, so a BOM is ignored.
  const withoutBom = text.replace(/^\uFEFF/, '');
  const rawLines = withoutBom.split(/\r\n|\r|\n/);
  const lines = rawLines.map((line) => line.trim()).filter((line) => line.length > 0);

  if (lines.length === 0) {
    issues.push(issue(0, 'Descriptor file is empty.', ''));
    return { entries, issues, ok: false };
  }

  const digits = expectedTrackNumberDigits(rawLines.length);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (!line.includes(';')) {
      if (line.includes(',')) {
        issues.push(
          issue(
            lineNumber,
            `Line ${lineNumber}: Found comma (,) but expected semicolon (;). ${FORMAT_HINT}\nLine content: '${line}'`,
            line,
          ),
        );
      } else {
        issues.push(
          issue(
            lineNumber,
            `Line ${lineNumber}: Missing semicolon (;). ${FORMAT_HINT}\nLine content: '${line}'`,
            line,
          ),
        );
      }
      return;
    }

    if (!line.includes(' -- ')) {
      if (line.includes(' - ')) {
        issues.push(
          issue(
            lineNumber,
            `Line ${lineNumber}: Found single dash (-) but expected double dash (--). ${FORMAT_HINT}\nLine content: '${line}'`,
            line,
          ),
        );
      } else {
        issues.push(
          issue(
            lineNumber,
            `Line ${lineNumber}: Missing double dash (--) separator. ${FORMAT_HINT}\nLine content: '${line}'`,
            line,
          ),
        );
      }
      return;
    }

    const digitsMatch = LEADING_DIGITS.exec(line);
    const foundNumber = digitsMatch
      ? Number.parseInt(digitsMatch[0], 10)
      : line.slice(0, digits);

    if (foundNumber !== lineNumber) {
      const expected = String(lineNumber).padStart(digits, '0');
      issues.push(
        issue(
          lineNumber,
          `Line ${lineNumber}: Track number mismatch. Expected '${expected}' but found '${foundNumber}'. Each line should start with the zero-padded line number.\nLine content: '${line}'`,
          line,
        ),
      );
      return;
    }

    const match = LINE_PATTERN.exec(line);
    if (!match) {
      issues.push(
        issue(
          lineNumber,
          `Line ${lineNumber}: Invalid format. Expected format: TRACKNUM_TITLE; ARTIST -- DANCE\nLine content: '${line}'`,
          line,
        ),
      );
      return;
    }

    entries.push({
      lineNumber,
      raw: line,
      trackNumber: match[1] as string,
      title: match[2] as string,
      artist: match[3] as string,
      dance: match[4] as string,
    });
  });

  return { entries, issues, ok: issues.length === 0 && entries.length > 0 };
}
