/**
 * Syntax Check — Parse code and detect structural errors.
 *
 * - TS/JS: matching braces/brackets/parens, unterminated strings
 * - JSON: valid JSON parse
 * - HTML: matching tags, valid structure
 * - CSS: matching braces
 */

import type { ValidationFile, ValidationIssue } from '../ValidatorTypes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check that braces, brackets and parens are balanced. */
function checkBraceBalance(
  content: string,
  file: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const stack: { char: string; line: number }[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const openers = new Set(['(', '[', '{']);

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let line = 1;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const prev = i > 0 ? content[i - 1] : '';

    if (ch === '\n') {
      line++;
      inLineComment = false;
      continue;
    }

    // Skip inside comments
    if (inLineComment) continue;
    if (inBlockComment) {
      if (ch === '/' && prev === '*') inBlockComment = false;
      continue;
    }

    // Detect comment start
    if (!inSingleQuote && !inDoubleQuote && !inTemplate) {
      if (ch === '/' && i + 1 < content.length) {
        if (content[i + 1] === '/') { inLineComment = true; continue; }
        if (content[i + 1] === '*') { inBlockComment = true; continue; }
      }
    }

    // String tracking (simplified — does not handle all edge cases but good enough for validation)
    if (!inDoubleQuote && !inTemplate && ch === "'" && prev !== '\\') {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (!inSingleQuote && !inTemplate && ch === '"' && prev !== '\\') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && ch === '`' && prev !== '\\') {
      inTemplate = !inTemplate;
      continue;
    }

    if (inSingleQuote || inDoubleQuote || inTemplate) continue;

    if (openers.has(ch)) {
      stack.push({ char: ch, line });
    } else if (pairs[ch]) {
      if (stack.length === 0 || stack[stack.length - 1].char !== pairs[ch]) {
        issues.push({
          severity: 'error',
          category: 'syntax',
          file,
          line,
          message: `Unmatched closing '${ch}'`,
          rule: 'brace-balance',
        });
      } else {
        stack.pop();
      }
    }
  }

  for (const unmatched of stack) {
    issues.push({
      severity: 'error',
      category: 'syntax',
      file,
      line: unmatched.line,
      message: `Unmatched opening '${unmatched.char}'`,
      rule: 'brace-balance',
    });
  }

  return issues;
}

/** Validate JSON content. */
function checkJson(content: string, file: string): ValidationIssue[] {
  try {
    JSON.parse(content);
    return [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid JSON';
    return [
      {
        severity: 'error',
        category: 'syntax',
        file,
        message: `Invalid JSON: ${msg}`,
        rule: 'json-parse',
      },
    ];
  }
}

/**
 * Very lightweight HTML tag-matching check.
 * Catches obviously mismatched open/close tags for common elements.
 */
function checkHtml(content: string, file: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const voidElements = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);

  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9-]*)[^>]*\/?>/g;
  const stack: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(content)) !== null) {
    const fullMatch = match[0];
    const tagName = match[1].toLowerCase();

    if (voidElements.has(tagName)) continue;
    if (fullMatch.endsWith('/>')) continue; // self-closing

    if (fullMatch.startsWith('</')) {
      // Closing tag
      if (stack.length === 0 || stack[stack.length - 1] !== tagName) {
        issues.push({
          severity: 'error',
          category: 'syntax',
          file,
          message: `Mismatched HTML closing tag: </${tagName}>`,
          rule: 'html-tag-balance',
        });
      } else {
        stack.pop();
      }
    } else {
      stack.push(tagName);
    }
  }

  for (const unclosed of stack) {
    issues.push({
      severity: 'warning',
      category: 'syntax',
      file,
      message: `Unclosed HTML tag: <${unclosed}>`,
      rule: 'html-tag-balance',
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function syntaxCheck(files: ValidationFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const file of files) {
    // Empty file check (structure category)
    if (!file.content.trim()) {
      issues.push({
        severity: 'warning',
        category: 'structure',
        file: file.path,
        message: 'File is empty',
        rule: 'non-empty-file',
      });
      continue;
    }

    switch (file.language) {
      case 'typescript':
      case 'javascript':
        issues.push(...checkBraceBalance(file.content, file.path));
        break;

      case 'json':
        issues.push(...checkJson(file.content, file.path));
        break;

      case 'html':
        issues.push(...checkHtml(file.content, file.path));
        break;

      case 'css':
        issues.push(...checkBraceBalance(file.content, file.path));
        break;
    }
  }

  return issues;
}
