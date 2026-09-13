#!/usr/bin/env node
// Builds the GitHub release body: the CHANGELOG.md section for a version
// (parsed by patchnotes, rendered as Markdown) + the install tutorial template.
//
//   patchnotes CHANGELOG.md json | node scripts/release-notes.mjs v0.2.0 owner/repo > notes.md

import { readFileSync, writeFileSync } from 'node:fs';

const tag = process.argv[2] ?? 'v0.0.0';
const repo = process.argv[3] ?? 'Londopy/gesture-synth';
const out = process.argv[4];
const version = tag.replace(/^v/, '');

const json = JSON.parse(readFileSync(0, 'utf8'));
let rel = json.releases.find((r) => r.version === version);
if (!rel) {
  rel = json.releases.find((r) => !r.is_unreleased);
  console.error(`CHANGELOG.md has no section for ${version}; using ${rel?.version ?? 'nothing'}.`);
}

const ORDER = ['Breaking', 'Security', 'Added', 'Changed', 'Deprecated', 'Removed', 'Fixed'];
let changes = '';
if (rel) {
  changes += `## What's in ${rel.version}${rel.release_date ? ` (${rel.release_date})` : ''}\n\n`;
  const types = Object.keys(rel.by_type ?? {}).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  for (const t of types) {
    const items = rel.by_type[t];
    if (!items?.length) continue;
    changes += `### ${t}\n\n`;
    for (const e of items) changes += `- ${e.text}\n`;
    changes += '\n';
  }
  if (rel.yanked) changes += '> This release was yanked.\n\n';
}

const tpl = readFileSync(new URL('../.github/release-notes-template.md', import.meta.url), 'utf8');
let body = tpl.replaceAll('{{CHANGES}}', changes.trim()).replaceAll('{{TAG}}', tag).replaceAll('{{REPO}}', repo);
if (body.startsWith('<!--')) body = body.slice(body.indexOf('-->') + 3).trimStart();
if (out) writeFileSync(out, body);
else process.stdout.write(body);
