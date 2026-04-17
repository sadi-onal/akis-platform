/**
 * Copy skill .md files from src/ into dist/ after tsc.
 *
 * tsc only emits .ts outputs. The SkillLoader resolves skills relative to
 * its own compiled location (dist/pipeline/agents/skills/), so the .md
 * bodies must live alongside it in the production image.
 */

import { readdirSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const srcDir = path.join(root, 'src/pipeline/agents/skills');
const destDir = path.join(root, 'dist/pipeline/agents/skills');

if (!existsSync(srcDir)) {
  console.error(`[copy-skill-assets] source not found: ${srcDir}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });

let copied = 0;
for (const entry of readdirSync(srcDir)) {
  if (!entry.endsWith('.md')) continue;
  copyFileSync(path.join(srcDir, entry), path.join(destDir, entry));
  copied++;
}

console.log(`[copy-skill-assets] copied ${copied} .md file(s) -> ${destDir}`);
