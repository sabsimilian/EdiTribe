const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');

const E2S_HEADER_SIZE = 0x1000;
const E2S_OFFSET_TABLE_START = 0x10;
const E2S_OFFSET_ENTRY_COUNT = (E2S_HEADER_SIZE - E2S_OFFSET_TABLE_START) / 4;
const E2S_FIRST_USER_DISPLAY_SLOT = 501;
const E2S_MAGIC = Buffer.from('e2s sample all\x1A\x00', 'binary');
const E2S_KORG_CHUNK_SIZE = 1180;
const E2S_KORG_TEMPLATE_PREFIX = Buffer.from(
  '65736C6994040000120048697070790000000000000000000000020032000000007F0001000000000000FD42FFFF0000000000004C6F00004C6F000001000000000000004E6F000001000001B00400003A7D0000000012000000000000000000',
  'hex'
);
const E2S_CATEGORY_CODES = {
  analog: 0,
  'audio in': 1,
  kick: 2,
  snare: 3,
  clap: 4,
  hihat: 5,
  cymbal: 6,
  hits: 7,
  shots: 8,
  voice: 9,
  se: 10,
  fx: 11,
  tom: 12,
  percussion: 13,
  'perc.': 13,
  phrase: 14,
  loop: 15,
  pcm: 16,
  user: 17,
};

function toLocalFsPath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') return null;
  if (inputPath.startsWith('file://')) {
    try {
      return fileURLToPath(inputPath);
    } catch {
      return null;
    }
  }
  if (path.isAbsolute(inputPath)) return inputPath;
  return null;
}

function parseWavMetadataFromBuffer(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let sampleRate = 0;
  let bitDepth = 0;
  let channels = 0;
  let dataSize = 0;
  let inam = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;
    const chunkDataEnd = chunkDataStart + chunkSize;
    if (chunkDataEnd > buffer.length) break;

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      channels = buffer.readUInt16LE(chunkDataStart + 2);
      sampleRate = buffer.readUInt32LE(chunkDataStart + 4);
      bitDepth = buffer.readUInt16LE(chunkDataStart + 14);
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
    } else if (chunkId === 'LIST' && chunkSize >= 4) {
      const listType = buffer.toString('ascii', chunkDataStart, chunkDataStart + 4);
      if (listType === 'INFO') {
        let infoOffset = chunkDataStart + 4;
        while (infoOffset + 8 <= chunkDataEnd) {
          const infoId = buffer.toString('ascii', infoOffset, infoOffset + 4);
          const infoSize = buffer.readUInt32LE(infoOffset + 4);
          const infoDataStart = infoOffset + 8;
          const infoDataEnd = infoDataStart + infoSize;
          if (infoDataEnd > chunkDataEnd) break;

          if (infoId === 'INAM') {
            const raw = buffer.toString('utf8', infoDataStart, infoDataEnd);
            inam = raw.replace(/\0+$/, '').trim() || null;
          }

          infoOffset = infoDataEnd + (infoSize % 2);
        }
      }
    }

    offset = chunkDataEnd + (chunkSize % 2);
  }

  const bytesPerSampleFrame = (channels * bitDepth) / 8;
  const duration = sampleRate && bytesPerSampleFrame && dataSize ? dataSize / (sampleRate * bytesPerSampleFrame) : undefined;
  return { sampleRate, bitDepth, channels, duration, inam };
}

function parseWavMetadata(filePath) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    return parseWavMetadataFromBuffer(fileBuffer);
  } catch {
    return null;
  }
}

function parseKorgMetadataFromRiffBuffer(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;
    const chunkDataEnd = chunkDataStart + chunkSize;
    if (chunkDataEnd > buffer.length) break;

    if (chunkId === 'korg' && chunkSize >= 26) {
      const payload = buffer.subarray(chunkDataStart, chunkDataEnd);
      const esli = payload.toString('ascii', 0, 4);
      const nameRaw = payload.toString('ascii', 10, 26);
      const name = nameRaw.replace(/\0+$/, '').trim();
      return {
        esli,
        name: name || null,
      };
    }

    offset = chunkDataEnd + (chunkSize % 2);
  }

  return null;
}

function extractRiffChunks(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;

  const riffSize = buffer.readUInt32LE(4) + 8;
  if (riffSize > buffer.length) return null;

  let offset = 12;
  const chunks = [];
  while (offset + 8 <= riffSize) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;
    const chunkDataEnd = chunkDataStart + chunkSize;
    if (chunkDataEnd > riffSize) break;

    chunks.push({
      id: chunkId,
      size: chunkSize,
      start: offset,
      end: chunkDataEnd + (chunkSize % 2),
      dataStart: chunkDataStart,
      dataEnd: chunkDataEnd,
    });

    offset = chunkDataEnd + (chunkSize % 2);
  }

  return chunks;
}

function parseWavForConversion(buffer) {
  const chunks = extractRiffChunks(buffer);
  if (!chunks) return null;

  const fmtChunk = chunks.find((c) => c.id === 'fmt ');
  const dataChunk = chunks.find((c) => c.id === 'data');
  if (!fmtChunk || !dataChunk) return null;
  if (fmtChunk.size < 16) return null;

  const fmtOffset = fmtChunk.dataStart;
  let audioFormat = buffer.readUInt16LE(fmtOffset);
  const channels = buffer.readUInt16LE(fmtOffset + 2);
  const sampleRate = buffer.readUInt32LE(fmtOffset + 4);
  let bitDepth = buffer.readUInt16LE(fmtOffset + 14);

  // Handle WAVE_FORMAT_EXTENSIBLE: read the actual sub-format and valid bits.
  if (audioFormat === 0xfffe && fmtChunk.size >= 40) {
    const validBitsPerSample = buffer.readUInt16LE(fmtOffset + 18);
    const subFormatCode = buffer.readUInt16LE(fmtOffset + 24);
    if (subFormatCode === 1 || subFormatCode === 3) {
      audioFormat = subFormatCode;
    }
    if (validBitsPerSample > 0) {
      bitDepth = validBitsPerSample;
    }
  }

  return {
    audioFormat,
    channels,
    sampleRate,
    bitDepth,
    dataStart: dataChunk.dataStart,
    dataSize: dataChunk.size,
  };
}

function clampUnit(value) {
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}

function decodePcmSample(buffer, offset, bitDepth, audioFormat) {
  if (audioFormat === 3 && bitDepth === 32) {
    return clampUnit(buffer.readFloatLE(offset));
  }

  if (audioFormat !== 1) {
    return 0;
  }

  if (bitDepth === 8) {
    return (buffer.readUInt8(offset) - 128) / 128;
  }
  if (bitDepth === 16) {
    return buffer.readInt16LE(offset) / 32768;
  }
  if (bitDepth === 24) {
    const raw = buffer.readIntLE(offset, 3);
    return raw / 8388608;
  }
  if (bitDepth === 32) {
    return buffer.readInt32LE(offset) / 2147483648;
  }

  return 0;
}

function encodePcmSample(buffer, offset, bitDepth, value) {
  const v = clampUnit(value);

  if (bitDepth === 8) {
    const out = Math.max(0, Math.min(255, Math.round(v * 127 + 128)));
    buffer.writeUInt8(out, offset);
    return;
  }
  if (bitDepth === 16) {
    const out = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    buffer.writeInt16LE(out, offset);
    return;
  }
  if (bitDepth === 24) {
    const out = Math.max(-8388608, Math.min(8388607, Math.round(v * 8388607)));
    buffer.writeIntLE(out, offset, 3);
    return;
  }
  if (bitDepth === 32) {
    const out = Math.max(-2147483648, Math.min(2147483647, Math.round(v * 2147483647)));
    buffer.writeInt32LE(out, offset);
  }
}

function convertWavBufferForE2S(buffer, conversion) {
  const parsed = parseWavForConversion(buffer);
  if (!parsed) return null;

  const inputAudioFormat = parsed.audioFormat;
  const inputChannels = parsed.channels;
  const inputRate = parsed.sampleRate;
  const inputBits = parsed.bitDepth;
  const bytesPerSample = inputBits / 8;
  const inFrameSize = inputChannels * bytesPerSample;

  if (!inputChannels || !inputRate || !inputBits || !inFrameSize || parsed.dataSize < inFrameSize) {
    return null;
  }

  const isPcm = inputAudioFormat === 1;
  const isFloat = inputAudioFormat === 3 && inputBits === 32;
  const supportedBits = inputBits === 8 || inputBits === 16 || inputBits === 24 || inputBits === 32;
  if ((!isPcm && !isFloat) || !supportedBits) {
    return null;
  }

  const inputFrameCount = Math.floor(parsed.dataSize / inFrameSize);
  if (inputFrameCount <= 0) return null;

  const requestedRate = Number(conversion && conversion.sampleRate);
  const requestedChannels = Number(conversion && conversion.channels);
  const requestedBits = Number(conversion && conversion.bitDepth);
  const volumeMode = conversion && conversion.volume === '+0dB' ? '+0dB' : '+12dB';
  const gain = volumeMode === '+12dB' ? 3.981071706 : 1;

  const outRate = Number.isFinite(requestedRate) && requestedRate > 0 ? Math.round(requestedRate) : inputRate;
  const outChannels = requestedChannels === 1 ? 1 : 2;
  // Empirically safest for Electribe import.
  const outBits = requestedBits === 8 || requestedBits === 16 || requestedBits === 24 || requestedBits === 32
    ? Math.min(requestedBits, 16)
    : 16;

  const outFrameCount = Math.max(1, Math.round((inputFrameCount * outRate) / inputRate));

  const inputChannelData = Array.from({ length: inputChannels }, () => new Float32Array(inputFrameCount));
  let readOffset = parsed.dataStart;
  for (let frame = 0; frame < inputFrameCount; frame++) {
    for (let ch = 0; ch < inputChannels; ch++) {
      inputChannelData[ch][frame] = decodePcmSample(buffer, readOffset, inputBits, inputAudioFormat);
      readOffset += bytesPerSample;
    }
  }

  const resampled = Array.from({ length: inputChannels }, () => new Float32Array(outFrameCount));
  for (let ch = 0; ch < inputChannels; ch++) {
    const src = inputChannelData[ch];
    if (outFrameCount === 1 || inputFrameCount === 1) {
      resampled[ch][0] = src[0] || 0;
      continue;
    }

    const scale = (inputFrameCount - 1) / (outFrameCount - 1);
    for (let i = 0; i < outFrameCount; i++) {
      const pos = i * scale;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = src[idx] || 0;
      const b = src[Math.min(idx + 1, inputFrameCount - 1)] || a;
      resampled[ch][i] = a + (b - a) * frac;
    }
  }

  const mixed = Array.from({ length: outChannels }, () => new Float32Array(outFrameCount));
  for (let i = 0; i < outFrameCount; i++) {
    if (outChannels === 1) {
      let sum = 0;
      for (let ch = 0; ch < inputChannels; ch++) sum += resampled[ch][i];
      mixed[0][i] = clampUnit((sum / inputChannels) * gain);
    } else {
      if (inputChannels === 1) {
        const v = clampUnit(resampled[0][i] * gain);
        mixed[0][i] = v;
        mixed[1][i] = v;
      } else {
        mixed[0][i] = clampUnit(resampled[0][i] * gain);
        mixed[1][i] = clampUnit(resampled[1][i] * gain);
      }
    }
  }

  const outBytesPerSample = outBits / 8;
  const outBlockAlign = outChannels * outBytesPerSample;
  const outByteRate = outRate * outBlockAlign;
  const outDataSize = outFrameCount * outBlockAlign;
  const outData = Buffer.alloc(outDataSize);

  let writeOffset = 0;
  for (let frame = 0; frame < outFrameCount; frame++) {
    for (let ch = 0; ch < outChannels; ch++) {
      encodePcmSample(outData, writeOffset, outBits, mixed[ch][frame]);
      writeOffset += outBytesPerSample;
    }
  }

  const fmtChunk = Buffer.alloc(24);
  fmtChunk.write('fmt ', 0, 'ascii');
  fmtChunk.writeUInt32LE(16, 4);
  fmtChunk.writeUInt16LE(1, 8);
  fmtChunk.writeUInt16LE(outChannels, 10);
  fmtChunk.writeUInt32LE(outRate, 12);
  fmtChunk.writeUInt32LE(outByteRate, 16);
  fmtChunk.writeUInt16LE(outBlockAlign, 20);
  fmtChunk.writeUInt16LE(outBits, 22);

  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(outDataSize, 4);

  const riffSize = 4 + fmtChunk.length + dataHeader.length + outData.length;
  const riffHeader = Buffer.alloc(12);
  riffHeader.write('RIFF', 0, 'ascii');
  riffHeader.writeUInt32LE(riffSize, 4);
  riffHeader.write('WAVE', 8, 'ascii');

  return Buffer.concat([riffHeader, fmtChunk, dataHeader, outData]);
}

function trimWavBuffer(buffer, startSec, endSec) {
  const parsed = parseWavForConversion(buffer);
  if (!parsed) return null;

  const channels = parsed.channels;
  const sampleRate = parsed.sampleRate;
  const bitDepth = parsed.bitDepth;
  const audioFormat = parsed.audioFormat;
  const bytesPerSample = bitDepth / 8;
  const frameBytes = channels * bytesPerSample;

  if (!channels || !sampleRate || !bitDepth || !frameBytes || parsed.dataSize < frameBytes) {
    return null;
  }

  const totalFrames = Math.floor(parsed.dataSize / frameBytes);
  if (totalFrames <= 0) return null;

  const clampedStartSec = Math.max(0, Number.isFinite(startSec) ? Number(startSec) : 0);
  const clampedEndSec = Math.max(clampedStartSec, Number.isFinite(endSec) ? Number(endSec) : (totalFrames / sampleRate));

  let startFrame = Math.floor(clampedStartSec * sampleRate);
  let endFrame = Math.ceil(clampedEndSec * sampleRate);

  startFrame = Math.max(0, Math.min(totalFrames - 1, startFrame));
  endFrame = Math.max(startFrame + 1, Math.min(totalFrames, endFrame));

  const startByte = parsed.dataStart + startFrame * frameBytes;
  const endByte = parsed.dataStart + endFrame * frameBytes;
  const outData = Buffer.from(buffer.subarray(startByte, endByte));

  const outBlockAlign = channels * bytesPerSample;
  const outByteRate = sampleRate * outBlockAlign;

  const fmtChunk = Buffer.alloc(24);
  fmtChunk.write('fmt ', 0, 'ascii');
  fmtChunk.writeUInt32LE(16, 4);
  fmtChunk.writeUInt16LE(audioFormat === 3 ? 3 : 1, 8);
  fmtChunk.writeUInt16LE(channels, 10);
  fmtChunk.writeUInt32LE(sampleRate, 12);
  fmtChunk.writeUInt32LE(outByteRate, 16);
  fmtChunk.writeUInt16LE(outBlockAlign, 20);
  fmtChunk.writeUInt16LE(bitDepth, 22);

  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(outData.length, 4);

  const riffSize = 4 + fmtChunk.length + dataHeader.length + outData.length;
  const riffHeader = Buffer.alloc(12);
  riffHeader.write('RIFF', 0, 'ascii');
  riffHeader.writeUInt32LE(riffSize, 4);
  riffHeader.write('WAVE', 8, 'ascii');

  return Buffer.concat([riffHeader, fmtChunk, dataHeader, outData]);
}

// slot is the 1-based display slot (e.g. 500 = first user slot).
// Returns the 0-based OSC index used inside the pointer table and korg chunk.
function getE2SOscIndex(slot) {
  const numericSlot = Math.trunc(Number(slot));
  if (!Number.isFinite(numericSlot)) return 499;
  return Math.max(0, Math.min(E2S_OFFSET_ENTRY_COUNT - 1, numericSlot - 1));
}

function getE2SCategoryCode(sample) {
  const category = String(sample && sample.category ? sample.category : 'user').trim().toLowerCase();
  return E2S_CATEGORY_CODES[category] ?? 17;
}

// oscIndex is already 0-based; clamp it directly without re-converting.
function getE2SImportNumber(oscIndex) {
  const safeIndex = Math.max(0, Math.min(E2S_OFFSET_ENTRY_COUNT - 1, Math.trunc(Number(oscIndex)) || 0));
  // On stock firmware the first writable user sample is slot 501 -> OSC index 500.
  if (safeIndex >= 500) {
    return 550 + (safeIndex - 500);
  }
  return 50 + safeIndex;
}

function getE2SPlayLogPeriod(sampleRate) {
  const safeRate = Math.max(1, Number(sampleRate) || 0);
  if (!safeRate) return 0xffff;
  const computed = Math.round(63132 - Math.log2(safeRate) * 3072);
  return Math.max(0, Math.min(0xffff, computed));
}

function createDefaultKorgChunk() {
  const payload = Buffer.alloc(E2S_KORG_CHUNK_SIZE, 0);
  E2S_KORG_TEMPLATE_PREFIX.copy(payload, 0);

  const chunk = Buffer.alloc(8 + E2S_KORG_CHUNK_SIZE, 0);
  chunk.write('korg', 0, 'ascii');
  chunk.writeUInt32LE(E2S_KORG_CHUNK_SIZE, 4);
  payload.copy(chunk, 8);
  return chunk;
}

function patchKorgChunk(chunkBuffer, { slot, name, dataSize, sampleRate, channels, category, exportType, playLevel12dB }) {
  const chunk = Buffer.isBuffer(chunkBuffer) ? Buffer.from(chunkBuffer) : createDefaultKorgChunk();
  const payloadSize = chunk.length >= 8 ? chunk.readUInt32LE(4) : 0;
  if (chunk.length < 8 + E2S_KORG_CHUNK_SIZE || payloadSize < E2S_KORG_CHUNK_SIZE) {
    return patchKorgChunk(createDefaultKorgChunk(), { slot, name, dataSize, sampleRate, channels, category, exportType, playLevel12dB });
  }

  const payload = chunk.subarray(8, 8 + E2S_KORG_CHUNK_SIZE);
  const safeOscIndex = getE2SOscIndex(slot);
  const safeName = String(name || `Slot_${String(safeOscIndex).padStart(3, '0')}`)
    .replace(/[^\x20-\x7E]/g, '')
    .slice(0, 16);
  const safeDataSize = Math.max(0, Number(dataSize) || 0);
  const safeSampleRate = Math.max(1, Number(sampleRate) || 32058);
  const safeChannels = Math.max(1, Math.min(2, Number(channels) || 1));
  const dataEnd = safeDataSize > safeChannels * 2 ? safeDataSize - (safeChannels * 2) : 0;
  const isOneShot = exportType !== 'full loop';

  chunk.write('korg', 0, 'ascii');
  chunk.writeUInt32LE(E2S_KORG_CHUNK_SIZE, 4);
  payload.write('esli', 0, 'ascii');
  payload.writeUInt32LE(0x494, 4);
  payload.writeUInt16LE(safeOscIndex, 8);
  payload.fill(0, 10, 26);
  payload.write(safeName, 10, 'ascii');
  payload.writeUInt16LE(E2S_CATEGORY_CODES[String(category || '').trim().toLowerCase()] ?? getE2SCategoryCode({ category }), 0x1a);
  payload.writeUInt16LE(getE2SImportNumber(safeOscIndex), 0x1c);
  payload.writeUInt16LE(getE2SPlayLogPeriod(safeSampleRate), 0x2a);
  payload.writeUInt16LE(0xffff, 0x2c);
  payload.writeUInt32LE(0, 0x30);
  payload.writeUInt32LE(isOneShot ? dataEnd >>> 0 : 0, 0x34);
  payload.writeUInt32LE(dataEnd >>> 0, 0x38);
  payload.writeUInt8(isOneShot ? 1 : 0, 0x3c);
  payload.writeUInt32LE(safeDataSize >>> 0, 0x44);
  payload.writeUInt8(1, 0x48);
  payload.writeUInt8(safeChannels > 1 ? 1 : 0, 0x49);
  payload.writeUInt8(playLevel12dB ? 1 : 0, 0x4a);
  payload.writeUInt32LE(safeSampleRate >>> 0, 0x50);
  payload.writeInt8(0, 0x55);
  payload.writeUInt16LE(safeOscIndex, 0x56);

  return chunk;
}

function createSyntheticKorgChunk({ slot, name, dataSize, sampleRate, channels, category, exportType, playLevel12dB }) {
  return patchKorgChunk(createDefaultKorgChunk(), {
    slot,
    name,
    dataSize,
    sampleRate,
    channels,
    category,
    exportType,
    playLevel12dB,
  });
}

function shouldBypassConversionForSample(sample, sourceMetadata, options = {}) {
  if (!options.shouldConvert) return true;
  if (sample && sample.sourceKind === 'e2s-embedded') return true;

  const rate = Number(sourceMetadata && sourceMetadata.sampleRate);
  const bitDepth = Number(sourceMetadata && sourceMetadata.bitDepth);
  const channels = Number(sourceMetadata && sourceMetadata.channels);
  if (Number.isFinite(rate) && Number.isFinite(bitDepth) && Number.isFinite(channels)) {
    // Keep original quality for already Electribe-friendly samples.
    if (rate < 48000 && bitDepth === 16 && channels === 1) {
      return true;
    }
  }

  return false;
}

function normalizeWavForE2S(buffer, slot, sampleName, sample, sourceMetadata = {}, options = {}) {
  let workingBuffer = buffer;
  const shouldConvertForSample = !shouldBypassConversionForSample(sample, sourceMetadata, options);
  if (shouldConvertForSample) {
    const converted = convertWavBufferForE2S(workingBuffer, options.conversion || {});
    if (!converted) return null;
    workingBuffer = converted;
  }

  const chunks = extractRiffChunks(workingBuffer);
  if (!chunks) return null;

  const fmtChunk = chunks.find((c) => c.id === 'fmt ');
  const dataChunk = chunks.find((c) => c.id === 'data');
  const korgChunk = chunks.find((c) => c.id === 'korg');
  if (!fmtChunk || !dataChunk) return null;

  const metadata = parseWavMetadataFromBuffer(workingBuffer) || {};
  const fmtBuffer = Buffer.from(workingBuffer.subarray(fmtChunk.start, fmtChunk.end));
  const dataBuffer = Buffer.from(workingBuffer.subarray(dataChunk.start, dataChunk.end));
  const dataSize = dataChunk.size;

  let finalKorgBuffer;
  if (korgChunk) {
    finalKorgBuffer = patchKorgChunk(Buffer.from(workingBuffer.subarray(korgChunk.start, korgChunk.end)), {
      slot,
      name: sampleName,
      dataSize,
      sampleRate: metadata.sampleRate,
      channels: metadata.channels,
      category: sample && sample.category,
      exportType: sample && sample.exportType,
      playLevel12dB: options && options.conversion && options.conversion.volume === '+12dB',
    });
  } else {
    finalKorgBuffer = createSyntheticKorgChunk({
      slot,
      name: sampleName,
      dataSize,
      sampleRate: metadata.sampleRate,
      channels: metadata.channels,
      category: sample && sample.category,
      exportType: sample && sample.exportType,
      playLevel12dB: options && options.conversion && options.conversion.volume === '+12dB',
    });
  }

  const riffPayloadSize = 4 + fmtBuffer.length + dataBuffer.length + finalKorgBuffer.length;
  const out = Buffer.alloc(8 + riffPayloadSize);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(riffPayloadSize, 4);
  out.write('WAVE', 8, 'ascii');

  let cursor = 12;
  fmtBuffer.copy(out, cursor);
  cursor += fmtBuffer.length;
  dataBuffer.copy(out, cursor);
  cursor += dataBuffer.length;
  finalKorgBuffer.copy(out, cursor);

  return out;
}

function parseE2SAllFile(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  if (fileBuffer.length < E2S_HEADER_SIZE) {
    throw new Error('Invalid e2s.all file: too small.');
  }

  if (!fileBuffer.subarray(0, E2S_MAGIC.length).equals(E2S_MAGIC)) {
    throw new Error('Invalid e2s.all file header.');
  }

  const samples = [];
  const warnings = [];
  for (let index = 0; index < E2S_OFFSET_ENTRY_COUNT; index++) {
    const tableOffset = E2S_OFFSET_TABLE_START + index * 4;
    const sampleOffset = fileBuffer.readUInt32LE(tableOffset);
    if (!sampleOffset) continue;
    if (sampleOffset + 12 > fileBuffer.length) {
      warnings.push(`Slot ${index + 1}: invalid offset 0x${sampleOffset.toString(16)}.`);
      continue;
    }
    if (fileBuffer.toString('ascii', sampleOffset, sampleOffset + 4) !== 'RIFF') {
      warnings.push(`Slot ${index + 1}: offset does not point to RIFF data.`);
      continue;
    }

    const riffSize = fileBuffer.readUInt32LE(sampleOffset + 4) + 8;
    const sampleEnd = sampleOffset + riffSize;
    if (sampleEnd > fileBuffer.length) {
      warnings.push(`Slot ${index + 1}: RIFF chunk exceeds file boundary.`);
      continue;
    }

    const wavBuffer = fileBuffer.subarray(sampleOffset, sampleEnd);
    const metadata = parseWavMetadataFromBuffer(wavBuffer) || {};
    const korgMetadata = parseKorgMetadataFromRiffBuffer(wavBuffer) || {};
    const displayName = korgMetadata.name || metadata.inam || `Slot_${String(index).padStart(3, '0')}.wav`;

    samples.push({
      slot: index + 1,
      name: displayName,
      path: `e2s://${filePath.replace(/\\/g, '/') }#${index}`,
      size: wavBuffer.length,
      sampleRate: metadata.sampleRate,
      bitDepth: metadata.bitDepth,
      channels: metadata.channels,
      duration: metadata.duration,
      sourceKind: 'e2s-embedded',
      sourceAllPath: filePath,
      sourceOffset: sampleOffset,
      sourceLength: wavBuffer.length,
    });
  }

  return { samples, warnings };
}

function buildE2SAllBinary(samples, options = {}) {
  const warnings = [];
  const strict = options.strict !== false;
  const header = Buffer.alloc(E2S_HEADER_SIZE, 0);
  E2S_MAGIC.copy(header, 0);

  const sourceCache = new Map();
  const bySlot = new Map();
  let validationErrors = 0;
  for (const sample of samples) {
    const rawSlot = Number(sample.slot);
    const slot = Math.trunc(rawSlot);
    if (!Number.isFinite(rawSlot) || slot < 1 || slot > E2S_OFFSET_ENTRY_COUNT || rawSlot !== slot) {
      warnings.push(`Skipping sample "${sample.name || 'Unknown'}": invalid slot ${sample.slot}.`);
      validationErrors += 1;
      continue;
    }

    if (strict && slot < E2S_FIRST_USER_DISPLAY_SLOT) {
      warnings.push(
        `Slot ${slot} is not writable on stock firmware. User samples must start at slot ${E2S_FIRST_USER_DISPLAY_SLOT}.`
      );
      validationErrors += 1;
      continue;
    }

    if (bySlot.has(slot)) {
      const existing = bySlot.get(slot);
      warnings.push(
        `Duplicate slot ${slot}: "${(existing && existing.name) || 'Unknown'}" conflicts with "${sample.name || 'Unknown'}".`
      );
      validationErrors += 1;
      continue;
    }

    bySlot.set(slot, sample);
  }

  if (strict && validationErrors > 0) {
    throw new Error(
      `Export aborted: found ${validationErrors} slot assignment issue(s). Please fix duplicate/invalid slot numbers and export again.`
    );
  }

  const chunks = [];
  let currentOffset = E2S_HEADER_SIZE;
  const sortedSlots = Array.from(bySlot.keys()).sort((a, b) => a - b);
  let skippedSamples = 0;
  const writtenSlotsList = [];

  for (const slot of sortedSlots) {
    const sample = bySlot.get(slot);
    let wavBuffer = null;

    if (sample && sample.sourceKind === 'e2s-embedded' && sample.sourceAllPath) {
      let sourceFile = sourceCache.get(sample.sourceAllPath);
      if (!sourceFile) {
        sourceFile = fs.readFileSync(sample.sourceAllPath);
        sourceCache.set(sample.sourceAllPath, sourceFile);
      }
      const offset = Number(sample.sourceOffset);
      const length = Number(sample.sourceLength);
      if (
        Number.isFinite(offset) && Number.isFinite(length) &&
        offset >= 0 && length > 12 && offset + length <= sourceFile.length
      ) {
        wavBuffer = Buffer.from(sourceFile.subarray(offset, offset + length));
      }
    }

    if (!wavBuffer && sample) {
      const sourcePath = toLocalFsPath(sample.path);
      if (sourcePath && fs.existsSync(sourcePath)) {
        wavBuffer = fs.readFileSync(sourcePath);
      }
    }

    if (!wavBuffer || wavBuffer.length < 12 || wavBuffer.toString('ascii', 0, 4) !== 'RIFF') {
      warnings.push(`Slot ${slot}: missing or non-RIFF source for "${(sample && sample.name) || 'Unknown'}".`);
      skippedSamples += 1;
      continue;
    }

    const sourceMetadata = parseWavMetadataFromBuffer(wavBuffer) || {};
    const normalizedWavBuffer = normalizeWavForE2S(
      wavBuffer,
      slot,
      sample && sample.name,
      sample,
      sourceMetadata,
      options,
    );
    if (!normalizedWavBuffer) {
      warnings.push(`Slot ${slot}: invalid RIFF layout for "${(sample && sample.name) || 'Unknown'}".`);
      skippedSamples += 1;
      continue;
    }

    // slot is 1-based display slot; osc index = slot - 1 (0-based pointer table entry).
    header.writeUInt32LE(currentOffset, E2S_OFFSET_TABLE_START + (slot - 1) * 4);
    writtenSlotsList.push(slot);
    chunks.push(normalizedWavBuffer);
    currentOffset += normalizedWavBuffer.length;
    if (normalizedWavBuffer.length % 2) {
      chunks.push(Buffer.from([0]));
      currentOffset += 1;
    }
  }

  if (strict && skippedSamples > 0) {
    throw new Error(
      `Export aborted: ${skippedSamples} sample(s) could not be encoded as valid RIFF/e2s data. Fix listed warnings and try again.`
    );
  }

  const binary = Buffer.concat([header, ...chunks]);

  if (strict) {
    const expectedSlots = new Set(writtenSlotsList);
    const nonZeroSlots = [];

    for (let index = 0; index < E2S_OFFSET_ENTRY_COUNT; index++) {
      const ptr = header.readUInt32LE(E2S_OFFSET_TABLE_START + index * 4);
      if (!ptr) continue;

      const displaySlot = index + 1;
      nonZeroSlots.push(displaySlot);

      if (!expectedSlots.has(displaySlot)) {
        throw new Error(`Export aborted: header contains unexpected pointer at slot ${displaySlot}.`);
      }

      if (ptr < E2S_HEADER_SIZE || ptr + 12 > binary.length) {
        throw new Error(`Export aborted: pointer for slot ${displaySlot} is out of bounds (0x${ptr.toString(16)}).`);
      }

      if (binary.toString('ascii', ptr, ptr + 4) !== 'RIFF') {
        throw new Error(`Export aborted: pointer for slot ${displaySlot} does not target RIFF data.`);
      }
    }

    if (nonZeroSlots.length !== expectedSlots.size) {
      throw new Error(
        `Export aborted: pointer count mismatch (${nonZeroSlots.length} pointers for ${expectedSlots.size} written sample(s)).`
      );
    }

    if (writtenSlotsList.length) {
      const highestWritten = writtenSlotsList[writtenSlotsList.length - 1];
      if (highestWritten < E2S_OFFSET_ENTRY_COUNT) {
        const trailingPtr = header.readUInt32LE(E2S_OFFSET_TABLE_START + highestWritten * 4);
        if (trailingPtr !== 0) {
          throw new Error(`Export aborted: trailing slot ${highestWritten + 1} should be empty but has a pointer.`);
        }
      }
    }
  }

  const writtenSlots = writtenSlotsList.length;
  return {
    binary,
    warnings,
    summary: {
      requestedSamples: Array.isArray(samples) ? samples.length : 0,
      uniqueSlotAssignments: sortedSlots.length,
      writtenSamples: writtenSlots,
      firstWrittenSlot: writtenSlotsList.length ? writtenSlotsList[0] : null,
      lastWrittenSlot: writtenSlotsList.length ? writtenSlotsList[writtenSlotsList.length - 1] : null,
    },
  };
}

// Recursively find all .wav files in a directory
const SUPPORTED_AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.aiff', '.aif', '.m4a', '.opus']);

function findWavFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const file of list) {
    const filePath = path.join(dir, file.name);
    if (file.isDirectory()) {
      results = results.concat(findWavFiles(filePath));
    } else if (file.isFile()) {
      const nameLower = file.name.toLowerCase();
      const ext = path.extname(nameLower);
      // Skip macOS resource forks, Ableton metadata, and unsupported file types
      if (file.name.startsWith('._') || nameLower.endsWith('.wav.asd') || !SUPPORTED_AUDIO_EXTENSIONS.has(ext)) {
        continue;
      }

      const stat = fs.statSync(filePath);
      const entry = {
        name: file.name,
        path: filePath,
        size: stat.size,
      };

      if (ext === '.wav') {
        // Validate and parse WAV metadata; skip corrupted files
        const metadata = parseWavMetadata(filePath);
        if (!metadata) continue;
        entry.sampleRate = metadata.sampleRate;
        entry.bitDepth = metadata.bitDepth;
        entry.channels = metadata.channels;
        entry.duration = metadata.duration;
      }
      // Non-WAV: return just name/path/size; renderer will decode for metadata

      results.push(entry);
    }
  }
  return results;
}

ipcMain.handle('get-wavs-from-folder', async (event, folderPath) => {
  if (!folderPath) return [];
  return findWavFiles(folderPath);
});

ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths.length) return [];
  const folder = result.filePaths[0];
  return findWavFiles(folder);
});

ipcMain.handle('get-app-version', async () => app.getVersion());

ipcMain.handle('open-e2s-all-dialog', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Electribe Sample All', extensions: ['all'] }],
  });
  if (result.canceled || !result.filePaths.length) {
    return { ok: false, canceled: true, samples: [], warnings: [] };
  }

  try {
    const filePath = result.filePaths[0];
    const parsed = parseE2SAllFile(filePath);
    return {
      ok: true,
      canceled: false,
      filePath,
      samples: parsed.samples,
      warnings: parsed.warnings,
    };
  } catch (error) {
    return {
      ok: false,
      canceled: false,
      samples: [],
      warnings: [],
      message: error && error.message ? error.message : 'Failed to open e2s.all file.',
    };
  }
});

ipcMain.handle('get-e2s-embedded-audio-data-url', async (event, payload) => {
  try {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload.' };
    }

    const sourceAllPath = toLocalFsPath(payload.sourceAllPath);
    const sourceOffset = Number(payload.sourceOffset);
    const sourceLength = Number(payload.sourceLength);

    if (!sourceAllPath || !fs.existsSync(sourceAllPath)) {
      return { ok: false, message: 'Source .all file not found.' };
    }

    if (!Number.isFinite(sourceOffset) || !Number.isFinite(sourceLength) || sourceOffset < 0 || sourceLength <= 12) {
      return { ok: false, message: 'Invalid source range.' };
    }

    const sourceBuffer = fs.readFileSync(sourceAllPath);
    if (sourceOffset + sourceLength > sourceBuffer.length) {
      return { ok: false, message: 'Source range exceeds file size.' };
    }

    const wavBuffer = Buffer.from(sourceBuffer.subarray(sourceOffset, sourceOffset + sourceLength));
    if (wavBuffer.toString('ascii', 0, 4) !== 'RIFF' || wavBuffer.toString('ascii', 8, 12) !== 'WAVE') {
      return { ok: false, message: 'Embedded sample is not a valid WAV RIFF block.' };
    }

    const base64 = wavBuffer.toString('base64');
    return {
      ok: true,
      dataUrl: `data:audio/wav;base64,${base64}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : 'Failed to read embedded sample audio.',
    };
  }
});

ipcMain.handle('save-audio-buffer-as-wav', async (event, payload) => {
  try {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload.' };
    }
    const nameBase = sanitizePathSegment(payload.nameBase || 'audio', 'audio');
    const data = payload.data;
    if (!data) return { ok: false, message: 'No audio data provided.' };
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

    const importDir = path.join(app.getPath('userData'), 'imported-audio');
    fs.mkdirSync(importDir, { recursive: true });

    const fileName = `${nameBase}_${Date.now()}.wav`;
    const outPath = ensureUniqueFilePath(path.join(importDir, fileName));
    fs.writeFileSync(outPath, buffer);

    return { ok: true, path: outPath, size: buffer.length };
  } catch (error) {
    return { ok: false, message: error && error.message ? error.message : 'Failed to save audio.' };
  }
});

ipcMain.handle('extract-embedded-sample-to-temp', async (event, payload) => {
  try {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload.' };
    }
    const sourceAllPath = toLocalFsPath(payload.sourceAllPath);
    const sourceOffset = Number(payload.sourceOffset);
    const sourceLength = Number(payload.sourceLength);
    const sampleName = sanitizePathSegment(payload.sampleName || 'sample', 'sample');

    if (!sourceAllPath || !fs.existsSync(sourceAllPath)) {
      return { ok: false, message: 'Source .all file not found.' };
    }
    if (!Number.isFinite(sourceOffset) || !Number.isFinite(sourceLength) || sourceOffset < 0 || sourceLength <= 12) {
      return { ok: false, message: 'Invalid source range.' };
    }

    const sourceBuffer = fs.readFileSync(sourceAllPath);
    if (sourceOffset + sourceLength > sourceBuffer.length) {
      return { ok: false, message: 'Source range exceeds file size.' };
    }
    const wavBuffer = Buffer.from(sourceBuffer.subarray(sourceOffset, sourceOffset + sourceLength));
    if (wavBuffer.toString('ascii', 0, 4) !== 'RIFF' || wavBuffer.toString('ascii', 8, 12) !== 'WAVE') {
      return { ok: false, message: 'Embedded sample is not valid WAV data.' };
    }

    const editsDir = path.join(app.getPath('userData'), 'edited-samples');
    fs.mkdirSync(editsDir, { recursive: true });
    const fileName = `${sampleName}_embedded_${Date.now()}.wav`;
    const outPath = ensureUniqueFilePath(path.join(editsDir, fileName));
    fs.writeFileSync(outPath, wavBuffer);

    const metadata = parseWavMetadataFromBuffer(wavBuffer) || {};
    return {
      ok: true,
      path: outPath,
      duration: metadata.duration,
      sampleRate: metadata.sampleRate,
      bitDepth: metadata.bitDepth,
      channels: metadata.channels,
    };
  } catch (error) {
    return { ok: false, message: error && error.message ? error.message : 'Failed to extract embedded sample.' };
  }
});

ipcMain.handle('trim-audio-file', async (event, payload) => {
  try {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid trim payload.' };
    }

    const sourcePath = toLocalFsPath(payload.sourcePath);
    const startSec = Number(payload.startSec);
    const endSec = Number(payload.endSec);
    const sampleName = typeof payload.sampleName === 'string' ? payload.sampleName : 'sample';

    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return { ok: false, message: 'Source file not found.' };
    }

    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
      return { ok: false, message: 'Invalid trim range.' };
    }

    const inputBuffer = fs.readFileSync(sourcePath);
    const trimmedBuffer = trimWavBuffer(inputBuffer, startSec, endSec);
    if (!trimmedBuffer) {
      return { ok: false, message: 'Could not trim WAV data from source file.' };
    }

    const editsDir = path.join(app.getPath('userData'), 'edited-samples');
    fs.mkdirSync(editsDir, { recursive: true });

    const trimmedNameBase = sanitizePathSegment(path.parse(sampleName).name || 'sample', 'sample');
    const fileName = `${trimmedNameBase}_trim_${Date.now()}.wav`;
    const outPath = ensureUniqueFilePath(path.join(editsDir, fileName));
    fs.writeFileSync(outPath, trimmedBuffer);

    const metadata = parseWavMetadataFromBuffer(trimmedBuffer) || {};
    return {
      ok: true,
      path: outPath,
      size: trimmedBuffer.length,
      duration: metadata.duration,
      sampleRate: metadata.sampleRate,
      bitDepth: metadata.bitDepth,
      channels: metadata.channels,
    };
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : 'Failed to trim audio file.',
    };
  }
});


ipcMain.handle('choose-export-directory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

function sanitizePathSegment(value, fallback) {
  const normalized = String(value || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  return normalized || fallback;
}

function ensureUniqueFilePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const parsed = path.parse(filePath);
  let counter = 2;
  while (true) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${counter})${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    counter += 1;
  }
}

function resolveSampleCopySource(sample) {
  if (sample && sample.sourceKind === 'e2s-embedded') {
    const sourceAllPath = toLocalFsPath(sample.sourceAllPath);
    const sourceOffset = Number(sample.sourceOffset);
    const sourceLength = Number(sample.sourceLength);
    if (!sourceAllPath || !fs.existsSync(sourceAllPath)) {
      throw new Error(`Missing source .all file for embedded sample "${sample.name || 'unknown'}".`);
    }
    if (!Number.isFinite(sourceOffset) || !Number.isFinite(sourceLength) || sourceOffset < 0 || sourceLength <= 12) {
      throw new Error(`Invalid embedded sample range for "${sample.name || 'unknown'}".`);
    }

    const sourceBuffer = fs.readFileSync(sourceAllPath);
    if (sourceOffset + sourceLength > sourceBuffer.length) {
      throw new Error(`Embedded sample range exceeds source file size for "${sample.name || 'unknown'}".`);
    }

    const wavBuffer = Buffer.from(sourceBuffer.subarray(sourceOffset, sourceOffset + sourceLength));
    if (wavBuffer.toString('ascii', 0, 4) !== 'RIFF' || wavBuffer.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`Embedded sample "${sample.name || 'unknown'}" is not valid WAV data.`);
    }

    return {
      buffer: wavBuffer,
      extension: '.wav',
    };
  }

  const sourcePath = toLocalFsPath(sample && sample.path);
  const altSourcePath = sourcePath
    ? sourcePath
    : (typeof sample?.path === 'string' && sample.path.startsWith('file://')
      ? sample.path.replace(/^file:\/\//, '').replace(/\//g, path.sep)
      : null);
  const finalSourcePath = sourcePath && fs.existsSync(sourcePath)
    ? sourcePath
    : (altSourcePath && fs.existsSync(altSourcePath) ? altSourcePath : null);

  if (!finalSourcePath) {
    throw new Error(`Source file not found for sample "${sample && sample.name ? sample.name : 'unknown'}".`);
  }

  return {
    sourcePath: finalSourcePath,
    extension: path.extname(finalSourcePath) || path.extname(sample.name || '') || '.wav',
  };
}

function exportSamplesAsSortedFolders(samples, outputDirectory, parentFolderName, options = {}) {
  const warnings = [];
  const rootFolder = path.join(outputDirectory, parentFolderName);
  fs.mkdirSync(rootFolder, { recursive: true });

  const shouldConvert = options.shouldConvert !== false;
  const conversion = options.conversion || {};
  const requestedFormat = typeof conversion.format === 'string' ? conversion.format.toLowerCase() : '.wav';
  const convertedExtension = requestedFormat === '.wav' ? '.wav' : '.wav';
  if (shouldConvert && requestedFormat !== '.wav') {
    warnings.push(`Sort mode conversion currently exports WAV only. Requested format ${requestedFormat} was mapped to .wav.`);
  }

  for (const sample of samples) {
    if (!sample) continue;
    const categoryFolderName = sanitizePathSegment(String(sample.category || 'Uncategorized').toLowerCase(), 'uncategorized');
    const categoryFolder = path.join(rootFolder, categoryFolderName);
    fs.mkdirSync(categoryFolder, { recursive: true });

    try {
      const source = resolveSampleCopySource(sample);
      const baseName = sanitizePathSegment(path.parse(sample.name || 'sample').name, 'sample');
      const extension = shouldConvert ? convertedExtension : (source.extension || '.wav');
      const destinationPath = ensureUniqueFilePath(path.join(categoryFolder, `${baseName}${extension}`));

      if (shouldConvert) {
        const sourceBuffer = source.buffer ? source.buffer : fs.readFileSync(source.sourcePath);
        const convertedBuffer = convertWavBufferForE2S(sourceBuffer, conversion);
        if (!convertedBuffer) {
          warnings.push(`Could not convert sample "${sample.name || 'unknown'}". Copied original instead.`);
          if (source.buffer) {
            fs.writeFileSync(destinationPath, source.buffer);
          } else {
            fs.copyFileSync(source.sourcePath, destinationPath);
          }
          continue;
        }
        fs.writeFileSync(destinationPath, convertedBuffer);
      } else if (source.buffer) {
        fs.writeFileSync(destinationPath, source.buffer);
      } else {
        fs.copyFileSync(source.sourcePath, destinationPath);
      }
    } catch (error) {
      warnings.push(error && error.message ? error.message : `Failed to copy sample "${sample.name || 'unknown'}".`);
    }
  }

  return {
    outPath: rootFolder,
    warnings,
  };
}

ipcMain.handle('export-e2s-all', async (event, payload) => {
  try {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid export payload.' };
    }

    const outputDirectory = payload.outputDirectory;
    const requestedFileName = typeof payload.fileName === 'string' ? payload.fileName.trim() : '';
    const samples = Array.isArray(payload.samples) ? payload.samples : [];
    const exportMode = payload.exportMode === 'placeholder-sort' ? 'placeholder-sort' : 'e2s-all';
    const conversion = payload.conversion || {};
    const shouldConvert = payload.shouldConvert !== false;

    if (!outputDirectory || !path.isAbsolute(outputDirectory)) {
      return { ok: false, message: 'Please choose a valid export directory.' };
    }
    if (!requestedFileName) {
      return { ok: false, message: 'Please provide a file name.' };
    }
    if (!samples.length) {
      return { ok: false, message: 'No chosen samples to export.' };
    }

    const safeBaseName = requestedFileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    const finalBaseName = safeBaseName.toLowerCase().endsWith('.all') ? safeBaseName.slice(0, -4) : safeBaseName;

    if (exportMode === 'placeholder-sort') {
      const result = exportSamplesAsSortedFolders(samples, outputDirectory, finalBaseName || 'sorted-samples', {
        shouldConvert,
        conversion,
      });
      return {
        ok: true,
        outPath: result.outPath,
        warnings: result.warnings,
        summary: {
          exportMode,
          sampleCount: samples.length,
        },
      };
    }

    const finalFileName = `${finalBaseName || 'e2s'}.all`;

    const { binary, warnings, summary } = buildE2SAllBinary(samples, {
      shouldConvert,
      conversion,
      strict: true,
    });
    if (!binary || binary.length <= E2S_HEADER_SIZE) {
      return { ok: false, message: 'No valid RIFF sample data could be exported.' };
    }

    const outPath = path.join(outputDirectory, finalFileName);
    fs.writeFileSync(outPath, binary);

    return {
      ok: true,
      outPath,
      warnings,
      summary: {
        shouldConvert,
        conversion,
        sampleCount: samples.length,
        requestedSamples: summary && summary.requestedSamples,
        uniqueSlotAssignments: summary && summary.uniqueSlotAssignments,
        writtenSamples: summary && summary.writtenSamples,
        firstWrittenSlot: summary && summary.firstWrittenSlot,
        lastWrittenSlot: summary && summary.lastWrittenSlot,
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : 'Failed to export e2s.all.'
    };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1260,
    height: 800,
    title: 'Editribe',
    icon: path.join(__dirname, 'IconRed.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.removeMenu();

  // Load the React app (development or production)
  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:3000');
  } else {
    win.loadFile(path.join(__dirname, 'src', 'ui', 'build', 'index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
