// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Adapt markdown to Feishu Card 2.0 (design 7.3). Only the necessary fixes are made, not a full markdown conversion:
 * - add the closing fence to a code block left unclosed in the middle of streaming, so that everything after it is not treated as code;
 * - turn external images (a card can only use img_key) into links;
 * - keep at most MAX_TABLES tables (a card limits the number of tables) and turn the rest into code blocks;
 * - neutralize Feishu extension tags such as `<at ...>`, to keep the agent from outputting @everyone.
 */
export const MAX_TABLES = 5;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const LARK_TAGS = /<(\/?)(at|font|text_tag|link|person|local_datetime|number_tag|record)\b/gi;

export function prepareCardMarkdown(input: string): string {
  const lines = input.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  let tables = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = FENCE.exec(line);
    if (fence) {
      out.push(line);
      if (m && m[1]!.startsWith(fence[0]!) && m[1]!.length >= fence.length && line.trim() === m[1]) fence = null;
      continue;
    }
    if (m) {
      fence = m[1]!;
      out.push(line);
      continue;
    }
    // Table: header row + separator row
    const next = lines[i + 1];
    if (line.includes('|') && next !== undefined && TABLE_SEP.test(next)) {
      let j = i + 2;
      while (j < lines.length && lines[j]!.includes('|') && lines[j]!.trim()) j++;
      const block = lines.slice(i, j);
      tables++;
      if (tables > MAX_TABLES) out.push('```', ...block, '```');
      else out.push(...block.map(fixInline));
      i = j - 1;
      continue;
    }
    out.push(fixInline(line));
  }
  if (fence) out.push(fence);
  return out.join('\n');
}

function fixInline(line: string): string {
  // Content inside inline code is left alone
  return line
    .split(/(`[^`]*`)/)
    .map((seg, idx) =>
      idx % 2 === 1
        ? seg
        : seg
            .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)[^)]*\)/g, (_m, alt: string, url: string) => `[${alt || '图片'}](${url})`)
            .replace(LARK_TAGS, '&lt;$1$2'),
    )
    .join('');
}
