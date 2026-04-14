#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const HEADER_SIZE = 0x1000;
const OFFSET_TABLE_START = 0x58;
const OFFSET_ENTRY_COUNT = (HEADER_SIZE - OFFSET_TABLE_START) / 4;
const MAGIC = 'e2s sample all';

function usage() {
  console.log('Usage: node scripts/e2s-diff.js <fileA.all> <fileB.all>');
}

function assertFile(filePath) {
  if (!filePath) {
    throw new Error('Missing file path argument.');
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  return resolved;
}

function parseOffsets(buffer) {
  const offsets = [];
  for (let i = 0; i < OFFSET_ENTRY_COUNT; i++) {
    const tableOffset = OFFSET_TABLE_START + i * 4;
    offsets.push(buffer.readUInt32LE(tableOffset));
  }
  return offsets;
}

function parseRiffChunks(buffer, offset) {
  if (offset + 12 > buffer.length) return null;
  if (buffer.toString('ascii', offset, offset + 4) !== 'RIFF') return null;

  const riffDataSize = buffer.readUInt32LE(offset + 4);
  const riffTotalSize = riffDataSize + 8;
  const riffEnd = offset + riffTotalSize;
  if (riffEnd > buffer.length) return null;

  const waveTag = buffer.toString('ascii', offset + 8, offset + 12);
  const chunks = [];
  let cursor = offset + 12;

  while (cursor + 8 <= riffEnd) {
    const id = buffer.toString('ascii', cursor, cursor + 4);
    const size = buffer.readUInt32LE(cursor + 4);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > riffEnd) break;
    chunks.push({ id, size });
    cursor = dataEnd + (size % 2);
  }

  return { waveTag, riffTotalSize, chunks };
}

function analyze(filePath) {
  const buffer = fs.readFileSync(filePath);
  const offsets = parseOffsets(buffer);
  const occupiedSlots = [];

  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] !== 0) occupiedSlots.push(i + 1);
  }

  return {
    filePath,
    buffer,
    size: buffer.length,
    magic: buffer.toString('ascii', 0, MAGIC.length),
    version16: buffer.readUInt16LE(0x0e),
    offsets,
    occupiedSlots,
  };
}

function firstDiff(a, b) {
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : min;
}

function diffHeader(a, b) {
  const maxHeader = Math.min(HEADER_SIZE, a.buffer.length, b.buffer.length);
  let count = 0;
  const sample = [];

  for (let i = 0; i < maxHeader; i++) {
    if (a.buffer[i] !== b.buffer[i]) {
      count += 1;
      if (sample.length < 25) {
        sample.push({ offset: i, a: a.buffer[i], b: b.buffer[i] });
      }
    }
  }

  return { count, sample };
}

function diffOffsets(a, b) {
  const changed = [];
  let occupiedA = 0;
  let occupiedB = 0;

  for (let i = 0; i < OFFSET_ENTRY_COUNT; i++) {
    const av = a.offsets[i];
    const bv = b.offsets[i];
    if (av !== 0) occupiedA += 1;
    if (bv !== 0) occupiedB += 1;
    if (av !== bv) {
      changed.push({ slot: i + 1, a: av, b: bv });
    }
  }

  return { changed, occupiedA, occupiedB };
}

function compareSharedSlots(a, b, maxRows = 30) {
  const rows = [];
  const shared = [];

  for (let i = 0; i < OFFSET_ENTRY_COUNT; i++) {
    if (a.offsets[i] !== 0 && b.offsets[i] !== 0) {
      shared.push(i + 1);
    }
  }

  for (const slot of shared) {
    const ai = slot - 1;
    const ao = a.offsets[ai];
    const bo = b.offsets[ai];
    const ar = parseRiffChunks(a.buffer, ao);
    const br = parseRiffChunks(b.buffer, bo);

    const row = {
      slot,
      riffOkA: !!ar,
      riffOkB: !!br,
      riffSizeA: ar ? ar.riffTotalSize : null,
      riffSizeB: br ? br.riffTotalSize : null,
      waveA: ar ? ar.waveTag : null,
      waveB: br ? br.waveTag : null,
      chunkIdsA: ar ? ar.chunks.map((c) => c.id).join(',') : null,
      chunkIdsB: br ? br.chunks.map((c) => c.id).join(',') : null,
    };

    const differs =
      row.riffOkA !== row.riffOkB ||
      row.riffSizeA !== row.riffSizeB ||
      row.waveA !== row.waveB ||
      row.chunkIdsA !== row.chunkIdsB;

    if (differs) rows.push(row);
    if (rows.length >= maxRows) break;
  }

  return rows;
}

function printDiff(fileA, fileB) {
  const a = analyze(fileA);
  const b = analyze(fileB);

  console.log('=== E2S Diff Report ===');
  console.log(`A: ${a.filePath}`);
  console.log(`B: ${b.filePath}`);
  console.log('');

  console.log('File-level:');
  console.log(`  size A=${a.size} B=${b.size} delta=${b.size - a.size}`);
  console.log(`  magic A="${a.magic}" B="${b.magic}"`);
  console.log(`  version@0x000E A=0x${a.version16.toString(16)} B=0x${b.version16.toString(16)}`);
  console.log(`  first byte diff: 0x${firstDiff(a.buffer, b.buffer).toString(16)}`);
  console.log('');

  const hd = diffHeader(a, b);
  console.log('Header (0x0000..0x0FFF):');
  console.log(`  differing bytes: ${hd.count}`);
  for (const row of hd.sample) {
    console.log(`  @0x${row.offset.toString(16).padStart(4, '0')}: A=0x${row.a.toString(16).padStart(2, '0')} B=0x${row.b.toString(16).padStart(2, '0')}`);
  }
  console.log('');

  const od = diffOffsets(a, b);
  console.log('Offset table:');
  console.log(`  occupied slots A=${od.occupiedA} B=${od.occupiedB}`);
  console.log(`  changed entries: ${od.changed.length}`);
  for (const row of od.changed.slice(0, 30)) {
    console.log(`  slot ${row.slot}: A=0x${row.a.toString(16).padStart(8, '0')} B=0x${row.b.toString(16).padStart(8, '0')}`);
  }
  console.log('');

  const sharedSlotDiffs = compareSharedSlots(a, b);
  console.log('Shared-slot RIFF layout differences (first 30 differing slots):');
  if (!sharedSlotDiffs.length) {
    console.log('  none');
  } else {
    for (const row of sharedSlotDiffs) {
      console.log(
        `  slot ${row.slot}: riffOk(A/B)=${row.riffOkA}/${row.riffOkB} size(A/B)=${row.riffSizeA}/${row.riffSizeB} wave(A/B)=${row.waveA}/${row.waveB}`
      );
      console.log(`    chunks A: ${row.chunkIdsA}`);
      console.log(`    chunks B: ${row.chunkIdsB}`);
    }
  }
}

try {
  const fileA = assertFile(process.argv[2]);
  const fileB = assertFile(process.argv[3]);
  printDiff(fileA, fileB);
} catch (err) {
  console.error(err.message || String(err));
  usage();
  process.exit(1);
}
