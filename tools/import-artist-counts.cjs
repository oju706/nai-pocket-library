'use strict';

// Import only the ARTIST_E JSON literal. The author's HTML is never executed.
const fs = require('node:fs');
const path = require('node:path');

function extractArtistData(html) {
  const declarations = [...html.matchAll(/\bconst\s+ARTIST_E\s*=\s*/g)];
  if (declarations.length !== 1) {
    throw new Error(`Expected exactly one const ARTIST_E declaration, found ${declarations.length}`);
  }

  const match = declarations[0];
  const start = match.index + match[0].length;
  if (html[start] !== '{') throw new Error('ARTIST_E must start with a JSON object literal');

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end < 0) throw new Error('Unterminated ARTIST_E object literal');
  let cursor = end + 1;
  while (cursor < html.length && /\s/.test(html[cursor])) cursor++;
  if (html[cursor] !== ';') throw new Error('ARTIST_E object literal must end with a semicolon');

  let value;
  try {
    value = JSON.parse(html.slice(start, end + 1));
  } catch (error) {
    throw new Error(`ARTIST_E is not valid JSON: ${error.message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ARTIST_E must be a JSON object');
  }
  return value;
}

function loadIndex(file) {
  const text = fs.readFileSync(file, 'utf8');
  let index;
  try {
    index = JSON.parse(text);
  } catch (error) {
    throw new Error(`Index is not valid JSON: ${error.message}`);
  }
  if (index === null || typeof index !== 'object' || Array.isArray(index)) {
    throw new Error('Index must be a JSON object');
  }
  if (!Array.isArray(index.artists)) throw new Error('Index artists must be an array');
  for (let i = 0; i < index.artists.length; i++) {
    const row = index.artists[i];
    if (!Array.isArray(row) || row.length < 2 || typeof row[0] !== 'string' || !Array.isArray(row[1])) {
      throw new Error(`Index artist row ${i} must contain a name and image ranges`);
    }
  }
  return index;
}

function writeAtomically(file, contents) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Ignore cleanup errors; the original error is more useful.
    }
    throw error;
  }
}

function isPostCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    throw new Error('Usage: node tools/import-artist-counts.cjs SOURCE_HTML INPUT_INDEX OUTPUT_INDEX');
  }
  const [sourceFile, inputFile, outputFile] = args;
  const artistData = extractArtistData(fs.readFileSync(sourceFile, 'utf8'));
  const index = loadIndex(inputFile);

  const sourceCounts = new Map(Object.entries(artistData));
  const expectedRows = index.artists.map((row) => ({
    name: row[0],
    images: JSON.stringify(row[1]),
    extras: row.slice(2),
  }));
  const sourceBefore = JSON.stringify(index.source);
  let matched = 0;
  let updated = 0;
  let invalid = 0;

  for (let i = 0; i < index.artists.length; i++) {
    const row = index.artists[i];
    const name = row[0];
    if (!sourceCounts.has(name)) continue;
    matched++;

    const record = sourceCounts.get(name);
    const count = Array.isArray(record) ? record[0] : undefined;
    if (!isPostCount(count)) {
      invalid++;
      continue;
    }

    row[2] = count;
    expectedRows[i].extras[0] = count;
    updated++;
  }

  const serialized = JSON.stringify(index);
  const written = JSON.parse(serialized);
  if (JSON.stringify(written.source) !== sourceBefore) {
    throw new Error('Source metadata changed during import');
  }
  if (written.artists.length !== expectedRows.length) {
    throw new Error('Artist count changed during import');
  }
  for (let i = 0; i < expectedRows.length; i++) {
    const expected = expectedRows[i];
    const actual = written.artists[i];
    if (actual[0] !== expected.name || JSON.stringify(actual[1]) !== expected.images ||
        JSON.stringify(actual.slice(2)) !== JSON.stringify(expected.extras)) {
      throw new Error(`Artist row ${i} changed unexpectedly`);
    }
  }

  writeAtomically(outputFile, serialized);
  console.log(JSON.stringify({
    artists: index.artists.length,
    matched,
    updated,
    invalid,
    missing: index.artists.length - matched,
  }));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
