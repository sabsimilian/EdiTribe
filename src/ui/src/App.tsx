import React, { useRef, useState, useEffect, KeyboardEvent } from 'react';
import './App.css';

type ConversionSettings = {
  format: '.wav' | '.mp3' | '.flac' | '.aiff' | '.ogg';
  sampleRate: number;
  bitDepth: number;
  channels: number;
  type: 'auto' | '1-shot' | 'full loop';
  volume: '+0dB' | '+12dB';
};
const ELECTRIBE_PRESET_NAME = 'Korg Electribe 2s';

const ELECTRIBE_PRESET: ConversionSettings = {
  format: '.wav',
  sampleRate: 48000,
  bitDepth: 16,
  channels: 1,
  type: 'auto',
  volume: '+12dB',
};

type Sample = {
  slot?: number;
  name: string;
  path: string;
  originalPath?: string;
  originalSize?: number;
  originalDuration?: number;
  originalSampleRate?: number;
  originalBitDepth?: number;
  originalChannels?: number;
  size: number;
  duration?: number;
  sampleRate?: number;
  bitDepth?: number;
  channels?: number;
  category?: string;
  sourceKind?: 'file' | 'e2s-embedded';
  sourceAllPath?: string;
  sourceOffset?: number;
  sourceLength?: number;
};

type SortField = 'name' | 'category' | 'size' | 'duration' | 'slot';

type ListFilter = {
  categories: string[];
  nameText: string;
  minSizeKB: string;
  maxSizeKB: string;
  minLengthSec: string;
  maxLengthSec: string;
};

const DEFAULT_LIST_FILTER: ListFilter = {
  categories: [],
  nameText: '',
  minSizeKB: '',
  maxSizeKB: '',
  minLengthSec: '',
  maxLengthSec: '',
};

const toOptionalNumber = (value: string): number | null => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isFilterActive = (f: ListFilter): boolean =>
  f.categories.length > 0 ||
  f.nameText.trim() !== '' ||
  f.minSizeKB.trim() !== '' ||
  f.maxSizeKB.trim() !== '' ||
  f.minLengthSec.trim() !== '' ||
  f.maxLengthSec.trim() !== '';

const matchesListFilter = (sample: Sample, filter: ListFilter): boolean => {
  const category = (sample.category || 'Hits').trim() || 'Hits';
  if (filter.categories.length > 0 && !filter.categories.includes(category)) return false;

  const trimmedNameText = filter.nameText.trim().toLowerCase();
  if (trimmedNameText && !sample.name.toLowerCase().includes(trimmedNameText)) return false;

  const sizeKB = sample.size / 1024;
  const minSizeKB = toOptionalNumber(filter.minSizeKB);
  const maxSizeKB = toOptionalNumber(filter.maxSizeKB);
  if (minSizeKB !== null && sizeKB < minSizeKB) return false;
  if (maxSizeKB !== null && sizeKB > maxSizeKB) return false;

  const durationSec = sample.duration;
  const minLengthSec = toOptionalNumber(filter.minLengthSec);
  const maxLengthSec = toOptionalNumber(filter.maxLengthSec);
  if (minLengthSec !== null) {
    if (!Number.isFinite(durationSec) || Number(durationSec) < minLengthSec) return false;
  }
  if (maxLengthSec !== null) {
    if (!Number.isFinite(durationSec) || Number(durationSec) > maxLengthSec) return false;
  }

  return true;
};

const dedupeSamplesByNameAndSize = (list: Sample[]): Sample[] => {
  const seen = new Set<string>();
  const unique: Sample[] = [];

  for (const sample of list) {
    const key = `${sample.name.toLowerCase()}::${sample.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(sample);
  }

  return unique;
};

function applySortToList(
  list: { sample: Sample; index: number }[],
  field: SortField | null,
  dir: 'asc' | 'desc',
  slotFn?: (index: number) => number
): { sample: Sample; index: number }[] {
  if (!field) return list;
  return [...list].sort((a, b) => {
    const m = dir === 'asc' ? 1 : -1;
    switch (field) {
      case 'name': return a.sample.name.localeCompare(b.sample.name, undefined, { sensitivity: 'base' }) * m;
      case 'category': return (a.sample.category || 'Hits').localeCompare(b.sample.category || 'Hits', undefined, { sensitivity: 'base' }) * m;
      case 'size': return (a.sample.size - b.sample.size) * m;
      case 'duration': return ((a.sample.duration ?? 0) - (b.sample.duration ?? 0)) * m;
      case 'slot': return slotFn ? (slotFn(a.index) - slotFn(b.index)) * m : (a.index - b.index) * m;
      default: return 0;
    }
  });
}

type ExportMode = 'e2s-all' | 'placeholder-sort';
const MAX_SAMPLE_RAM_BYTES = 26214396; // 26.21 MB / ~25 MiB (Electribe 2 sample RAM limit)
const MIN_TRIM_SECONDS = 0.01;

function App() {
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showGroupSortDialog, setShowGroupSortDialog] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [appVersion, setAppVersion] = useState<string>('');
  const [groupOrder, setGroupOrder] = useState<string[]>([]);
  const [groupStarts, setGroupStarts] = useState<Record<string, string>>({});
  const [dragCategory, setDragCategory] = useState<string | null>(null);
  const [conversion, setConversion] = useState<ConversionSettings>(ELECTRIBE_PRESET);
  const [exportMode, setExportMode] = useState<ExportMode>('e2s-all');
  const [exportConvert, setExportConvert] = useState(true);
  const [exportDirectory, setExportDirectory] = useState('');
  const [exportFileName, setExportFileName] = useState('e2sSample');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState<string>('');
  const [samples, setSamples] = useState<Sample[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]); // Multi-select
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null); // For shift selection
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [chosen, setChosen] = useState<Sample[]>([]);
  const [chosenSelectedIndices, setChosenSelectedIndices] = useState<number[]>([]);
  const [chosenLastSelectedIndex, setChosenLastSelectedIndex] = useState<number | null>(null);
  const [chosenNumberOffset, setChosenNumberOffset] = useState(500);
  const [chosenSlotDrafts, setChosenSlotDrafts] = useState<Record<number, string>>({});
  const chosenSlotSkipBlurCommitRef = useRef<Record<number, boolean>>({});
  const [showSampleLimitWarning, setShowSampleLimitWarning] = useState(false);
  const [showSamplesFilterModal, setShowSamplesFilterModal] = useState(false);
  const [showChosenFilterModal, setShowChosenFilterModal] = useState(false);
  const [samplesFilterDraft, setSamplesFilterDraft] = useState<ListFilter>(DEFAULT_LIST_FILTER);
  const [chosenFilterDraft, setChosenFilterDraft] = useState<ListFilter>(DEFAULT_LIST_FILTER);
  const [samplesFilterApplied, setSamplesFilterApplied] = useState<ListFilter>(DEFAULT_LIST_FILTER);
  const [chosenFilterApplied, setChosenFilterApplied] = useState<ListFilter>(DEFAULT_LIST_FILTER);
  const [samplesSortField, setSamplesSortField] = useState<SortField | null>(null);
  const [samplesSortDir, setSamplesSortDir] = useState<'asc' | 'desc'>('asc');
  const [chosenSortField, setChosenSortField] = useState<SortField | null>(null);
  const [chosenSortDir, setChosenSortDir] = useState<'asc' | 'desc'>('asc');
  const [nowPlayingName, setNowPlayingName] = useState<string | null>(null);
  const [playerCurrentTime, setPlayerCurrentTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);
  const [playerIsPlaying, setPlayerIsPlaying] = useState(false);
  const [activeList, setActiveList] = useState<'samples' | 'chosen'>('samples');
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editMessage, setEditMessage] = useState('');
  const [editTargetIndex, setEditTargetIndex] = useState<number | null>(null);
  const [editSourcePath, setEditSourcePath] = useState<string | null>(null);
  const [editPreviewPath, setEditPreviewPath] = useState<string | null>(null);
  const [editDurationSec, setEditDurationSec] = useState(0);
  const [editStartSec, setEditStartSec] = useState(0);
  const [editEndSec, setEditEndSec] = useState(0);
  const [editCursorSec, setEditCursorSec] = useState(0);
  const [editLoopPlaying, setEditLoopPlaying] = useState(false);
  const [editSnapEnabled, setEditSnapEnabled] = useState(true);
  const [editBpmText, setEditBpmText] = useState('120');
  const [editStepsPerBeat, setEditStepsPerBeat] = useState(4);
  const [editWaveformBusy, setEditWaveformBusy] = useState(false);
  const [editWaveformVersion, setEditWaveformVersion] = useState(0);
  const [editDragTarget, setEditDragTarget] = useState<'start' | 'end' | null>(null);
  const [editZoom, setEditZoom] = useState(1);
  const audioRef = useRef<HTMLAudioElement>(null);
  const editWaveformViewportRef = useRef<HTMLDivElement>(null);
  const editWaveformRef = useRef<HTMLDivElement>(null);
  const editWaveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const editPreviewCtxRef = useRef<AudioContext | null>(null);
  const editPreviewBufferRef = useRef<AudioBuffer | null>(null);
  const editPreviewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const editPreviewStartedAtRef = useRef(0);
  const editPreviewStartOffsetRef = useRef(0);
  const editPreviewModeRef = useRef<'idle' | 'loop' | 'once'>('idle');
  const editPreviewRafRef = useRef<number | null>(null);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sampleListContainerRef = useRef<HTMLDivElement>(null);
  const ramLimitApplies = exportMode === 'e2s-all';
  const USER_SLOT_START = 501;

  // --- Group Sort Preview Slot Calculation ---
  // Returns a map of category to [start, end) slot numbers for the current groupOrder,
  // always starting at the first user slot and incrementing by count.
  const getGroupSortPreviewSlots = () => {
    const countByCategory = new Map<string, number>();
    for (const sample of chosen) {
      const cat = (sample.category || 'Hits').trim() || 'Hits';
      countByCategory.set(cat, (countByCategory.get(cat) || 0) + 1);
    }
    let cursor = USER_SLOT_START;
    const slots: Record<string, [number, number]> = {};
    for (let i = 0; i < groupOrder.length; i++) {
      const cat = groupOrder[i];
      const count = countByCategory.get(cat) || 0;
      slots[cat] = [cursor, cursor + count];
      cursor += count;
    }
    return slots;
  };

  const squashRepeats = (value: string) => value.replace(/(.)\1{2,}/g, '$1$1');

  const inferCategoryFromName = (fileName: string, durationSec?: number): string => {
    const base = fileName.replace(/\.[^/.]+$/, '').toLowerCase();
    const squashed = squashRepeats(base);
    const compact = squashed.replace(/[^a-z0-9]+/g, '');
    const tokens = squashed.split(/[^a-z0-9]+/).filter(Boolean);

    const hasCompact = (pattern: RegExp) => pattern.test(compact);
    const hasToken = (pattern: RegExp) => tokens.some(t => pattern.test(t));
    const hasAny = (patterns: RegExp[]) => patterns.some(p => hasCompact(p) || hasToken(p));

    if (hasAny([/k+i+c+k+/, /^kick/, /bassdrum/])) return 'Kick';
    if (hasAny([/s+n+a+r+e+/, /\bsnr\b/, /^snare/])) return 'Snare';
    if (hasAny([/c+l+a+p+/, /^clap/])) return 'Clap';
    if (hasAny([/h+i*h+a*t+/, /\bhat\b/, /^hh$/, /^oh$/, /^ch$/, /openhat/, /closedhat/])) return 'HiHat';
    if (hasAny([/c+r+a+s+h+/, /r+i+d+e+/, /cymbal/])) return 'Cymbal';
    if (hasAny([/t+o+m+/, /^tom/])) return 'Tom';
    if (hasAny([/p+e+r+c+/, /^perc/, /r+i+m+/, /rimshot/])) return 'Percussion';
    if (hasAny([/v+o+x+/, /v+o+c+a+l+/, /sing/, /choir/])) return 'Voice';
    if (hasAny([/f+x+/, /sfx/, /effect/])) return 'FX';
    if (hasAny([/p+h+r+a+s+e+/, /phrase/, /riff/, /groove/])) return 'Phrase';
    if (hasAny([/l+o+o+p+/])) return 'Loop';
    if (hasAny([/analog/, /synth/, /lead/, /pad/, /pluck/, /chord/, /stab/, /bass/, /sub/, /808/])) return 'Analog';
    if (hasAny([/oneshot/, /one\s*shot/, /shot/, /hit/])) return 'Shots';

    if (typeof durationSec === 'number') {
      if (durationSec > 6) return 'Loop';
      return 'Shots';
    }

    return 'Hits';
  };

  const parseWavMetadataFromArrayBuffer = (buffer: ArrayBuffer): {
    sampleRate?: number;
    bitDepth?: number;
    channels?: number;
    duration?: number;
  } | null => {
    try {
      const view = new DataView(buffer);
      const readString = (offset: number, length: number) => {
        let out = '';
        for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
        return out;
      };

      if (readString(0, 4) !== 'RIFF' || readString(8, 4) !== 'WAVE') return null;

      let offset = 12;
      let sampleRate: number | undefined;
      let bitDepth: number | undefined;
      let channels: number | undefined;
      let dataSize: number | undefined;

      while (offset + 8 <= view.byteLength) {
        const chunkId = readString(offset, 4);
        const chunkSize = view.getUint32(offset + 4, true);
        offset += 8;

        if (chunkId === 'fmt ' && offset + 16 <= view.byteLength) {
          channels = view.getUint16(offset + 2, true);
          sampleRate = view.getUint32(offset + 4, true);
          bitDepth = view.getUint16(offset + 14, true);
        } else if (chunkId === 'data') {
          dataSize = chunkSize;
        }

        offset += chunkSize + (chunkSize % 2);
        if (sampleRate && bitDepth && channels && dataSize) break;
      }

      const bytesPerSampleFrame = sampleRate && bitDepth && channels ? (channels * bitDepth) / 8 : 0;
      const duration = sampleRate && bytesPerSampleFrame && dataSize ? dataSize / (sampleRate * bytesPerSampleFrame) : undefined;
      if (!sampleRate || !bitDepth || !channels || !dataSize) return null;
      return { sampleRate, bitDepth, channels, duration };
    } catch {
      return null;
    }
  };

  const formatPlayerTime = (sec: number) => {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds || !Number.isFinite(seconds)) return '--:--';
    const total = Math.max(0, Math.round(seconds));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  // Recursively get all .wav files from a DataTransferItem (folder or file)
  const getAllWavFiles = async (items: DataTransferItemList): Promise<File[]> => {
    const files: File[] = [];
    const promises: Promise<void>[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const entry = (item as any).webkitGetAsEntry?.();
      if (entry) {
        promises.push(
          new Promise<void>((resolve) => {
            const traverse = (entry: any, path = "") => {
              if (entry.isFile) {
                entry.file((file: File) => {
                  const nameLower = file.name.toLowerCase();
                  if (
                    !file.name.startsWith('._') &&
                    !nameLower.endsWith('.wav.asd') &&
                      isAudioFile(file.name)
                  ) {
                    files.push(file);
                  }
                  resolve();
                });
              } else if (entry.isDirectory) {
                const reader = entry.createReader();
                reader.readEntries((entries: any[]) => {
                  if (entries.length === 0) return resolve();
                  let left = entries.length;
                  entries.forEach((ent) => {
                    traverse(ent, path + entry.name + "/");
                    left--;
                    if (left === 0) resolve();
                  });
                });
              } else {
                resolve();
              }
            };
            traverse(entry);
          })
        );
      }
    }
    await Promise.all(promises);
    return files;
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
      // Try to detect folder drop (Electron only)
      const items = e.dataTransfer.items;
      let folderPath: string | null = null;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        // Electron exposes a path property on files
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file && (file as any).path && file.type === "") {
            // If type is empty, it's likely a folder
            folderPath = (file as any).path;
            break;
          }
        }
      }
      if (folderPath && window.electronAPI) {
        // Ask main process for all wav files recursively
        const files = await window.electronAPI.getWavsFromFolder(folderPath);
        if (files && Array.isArray(files)) {
          const newSamples: Sample[] = [];
          for (const f of files) {
            if (f.sampleRate) {
              newSamples.push({ name: f.name, path: f.path, size: f.size, duration: f.duration, sampleRate: f.sampleRate, bitDepth: f.bitDepth, channels: f.channels, category: inferCategoryFromName(f.name, f.duration) });
            } else {
              const converted = await convertExternalAudioToSample(f.path, f.name, f.size);
              if (converted) newSamples.push(converted);
            }
          }
          setSamples(prev => dedupeSamplesByNameAndSize([...prev, ...newSamples]));
        }
        return;
      }
      // Fallback: browser drag-and-drop for files
      let files: File[] = [];
      if ((e.dataTransfer.items && (e.dataTransfer.items[0] as any).webkitGetAsEntry)) {
        files = await getAllWavFiles(e.dataTransfer.items);
      } else {
        files = Array.from(e.dataTransfer.files).filter((f) => {
          const nameLower = f.name.toLowerCase();
          return !f.name.startsWith('._') && !nameLower.endsWith('.wav.asd') && isAudioFile(f.name);
        });
      }
      const skippedNames: string[] = [];
      const droppedSamples = await Promise.all(files.map(async (f) => {
        const droppedPath = (f as any).path as string | undefined;
        const isWav = f.name.toLowerCase().endsWith('.wav');
        if (window.electronAPI && !droppedPath) {
          skippedNames.push(f.name);
          return null;
        }
        if (!isWav && droppedPath) {
          // Non-WAV in Electron: decode and convert to temp WAV
          return convertExternalAudioToSample(droppedPath, f.name, f.size);
        }
        // WAV path
        const wavMeta = parseWavMetadataFromArrayBuffer(await f.arrayBuffer());
        if (!wavMeta) { skippedNames.push(f.name); return null; }
        const resolvedPath = droppedPath || URL.createObjectURL(f);
        return { name: f.name, path: resolvedPath, size: f.size, duration: wavMeta.duration, sampleRate: wavMeta.sampleRate, bitDepth: wavMeta.bitDepth, channels: wavMeta.channels, category: inferCategoryFromName(f.name, wavMeta.duration) };
      }));
      const newSamples: Sample[] = droppedSamples.filter((sample): sample is NonNullable<typeof sample> => sample !== null);
      if (skippedNames.length) {
        setExportMessage(`Skipped ${skippedNames.length} unsupported/invalid dropped file(s).`);
      }
      setSamples(prev => dedupeSamplesByNameAndSize([...prev, ...newSamples]));
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const SUPPORTED_AUDIO_EXTS = ['.wav', '.mp3', '.flac', '.ogg', '.aiff', '.aif', '.m4a', '.opus'];
  const isAudioFile = (name: string) => {
    const lower = name.toLowerCase();
    return SUPPORTED_AUDIO_EXTS.some(ext => lower.endsWith(ext));
  };

  const encodeAudioBufferToWav = (audioBuffer: AudioBuffer): ArrayBuffer => {
    const channels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const frames = audioBuffer.length;
    const dataSize = frames * channels * 2; // 16-bit
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);
    const ws = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true);
    ws(8, 'WAVE'); ws(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true); ws(36, 'data'); view.setUint32(40, dataSize, true);
    let off = 44;
    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < channels; ch++) {
        const v = Math.max(-1, Math.min(1, audioBuffer.getChannelData(ch)[i]));
        view.setInt16(off, Math.round(v * 32767), true);
        off += 2;
      }
    }
    return buf;
  };

  const convertExternalAudioToSample = async (filePath: string, originalName: string, originalSize: number): Promise<Sample | null> => {
    if (!window.electronAPI?.saveAudioBufferAsWav) return null;
    try {
      const fileUrl = toFileUrlFromFsPath(filePath);
      if (!fileUrl) return null;
      const response = await fetch(fileUrl);
      const arrayBuffer = await response.arrayBuffer();
      const ctx = new AudioContext();
      let audioBuffer: AudioBuffer;
      try {
        audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      } finally {
        await ctx.close();
      }
      const wavArrayBuffer = encodeAudioBufferToWav(audioBuffer);
      const nameBase = originalName.replace(/\.[^/.]+$/, '');
      const result = await window.electronAPI.saveAudioBufferAsWav({ nameBase, data: wavArrayBuffer });
      if (!result?.ok || !result.path) return null;
      return {
        name: originalName,
        path: result.path,
        size: result.size || wavArrayBuffer.byteLength,
        sampleRate: audioBuffer.sampleRate,
        bitDepth: 16,
        channels: audioBuffer.numberOfChannels,
        duration: audioBuffer.duration,
        category: inferCategoryFromName(originalName, audioBuffer.duration),
      };
    } catch {
      return null;
    }
  };

  const toFileUrlFromFsPath = (value: string): string | null => {
    if (!value) return null;
    if (value.startsWith('file://')) return value.replace(/#/g, '%23');

    const normalized = value.replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(normalized)) {
      return `file:///${encodeURI(normalized).replace(/#/g, '%23')}`;
    }
    if (normalized.startsWith('/')) {
      return `file://${encodeURI(normalized).replace(/#/g, '%23')}`;
    }

    return null;
  };

  const resolvePlaybackPath = async (sample: Sample): Promise<string | null> => {
    if (!sample) return null;

    if (sample.sourceKind === 'e2s-embedded' && window.electronAPI?.getE2sEmbeddedAudioDataUrl) {
      const result = await window.electronAPI.getE2sEmbeddedAudioDataUrl({
        sourceAllPath: sample.sourceAllPath,
        sourceOffset: sample.sourceOffset,
        sourceLength: sample.sourceLength,
      });
      if (result?.ok && result.dataUrl) return result.dataUrl;
      return null;
    }

    const p = sample.path;
    if (!p) return null;
    // Convert absolute filesystem paths to properly escaped file URLs (important for # in folder names).
    if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/')) {
      return toFileUrlFromFsPath(p);
    }
    if (p.startsWith('file://')) {
      return p.replace(/#/g, '%23');
    }
    return p;
  };

  const toFsPath = (value: string): string | null => {
    if (!value) return null;
    if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/')) return value;
    if (value.startsWith('file://')) {
      try {
        const url = new URL(value);
        const decodedPath = decodeURIComponent(url.pathname);
        if (/^\/[a-zA-Z]:\//.test(decodedPath)) {
          return decodedPath.slice(1).replace(/\//g, '\\');
        }
        return decodedPath;
      } catch {
        return null;
      }
    }
    return null;
  };

  const playSample = async (sample: Sample) => {
    const playbackPath = await resolvePlaybackPath(sample);
    if (!playbackPath) return;

    setNowPlayingName(sample.name);
    setPlayerCurrentTime(0);
    setPlayerDuration(0);
    if (audioRef.current) {
      audioRef.current.src = playbackPath;
      void audioRef.current.play();
    }
  };

  const cancelScheduledPreview = () => {
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
  };

  const schedulePreview = (sample: Sample, delayMs = 180) => {
    cancelScheduledPreview();
    previewTimeoutRef.current = setTimeout(() => {
      previewTimeoutRef.current = null;
      void playSample(sample);
    }, delayMs);
  };

  const getCurrentSampleForActiveList = () => {
    if (activeList === 'chosen') {
      const chosenIndex = chosenSelectedIndices.length ? chosenSelectedIndices[chosenSelectedIndices.length - 1] : -1;
      return chosenIndex >= 0 ? chosen[chosenIndex] || null : null;
    }

    return currentIndex !== null && currentIndex >= 0 ? samples[currentIndex] || null : null;
  };

  const handleSelect = (idx: number, e?: React.MouseEvent | KeyboardEvent, previewMode: 'immediate' | 'delayed' | 'none' = 'immediate') => {
    setActiveList('samples');
    setCurrentIndex(idx);
    if (e && (e.ctrlKey || e.metaKey)) {
      setSelectedIndices(prev => prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx]);
      setLastSelectedIndex(idx);
    } else if (e && e.shiftKey && lastSelectedIndex !== null) {
      // Range select
      const [start, end] = [lastSelectedIndex, idx].sort((a, b) => a - b);
      setSelectedIndices(Array.from({length: end - start + 1}, (_, i) => i + start));
    } else {
      setSelectedIndices([idx]);
      setLastSelectedIndex(idx);
    }

    if (!samples[idx]) return;
    if (previewMode === 'immediate') {
      cancelScheduledPreview();
      void playSample(samples[idx]);
    } else if (previewMode === 'delayed') {
      schedulePreview(samples[idx]);
    }
  };

  const handleChosenSelect = (idx: number) => {
    setActiveList('chosen');
    const selected = chosen[idx];
    if (!selected) return;
    const sourceIdx = samples.findIndex(s => s.path === selected.path);
    setCurrentIndex(sourceIdx >= 0 ? sourceIdx : null);
    void playSample(selected);
  };

  const handleChosenMultiSelect = (idx: number, e?: React.MouseEvent | KeyboardEvent) => {
    setActiveList('chosen');
    const selected = chosen[idx];
    if (!selected) return;
    if (e && (e.ctrlKey || e.metaKey)) {
      setChosenSelectedIndices(prev => prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx]);
      setChosenLastSelectedIndex(idx);
    } else if (e && e.shiftKey && chosenLastSelectedIndex !== null) {
      const [start, end] = [chosenLastSelectedIndex, idx].sort((a, b) => a - b);
      setChosenSelectedIndices(Array.from({ length: end - start + 1 }, (_, i) => i + start));
    } else {
      setChosenSelectedIndices([idx]);
      setChosenLastSelectedIndex(idx);
    }

    handleChosenSelect(idx);
  };

  const handleDeleteSelectedSamples = () => {
    if (!selectedIndices.length) return;
    setSamples(prev => prev.filter((_, idx) => !selectedIndices.includes(idx)));
    setSelectedIndices([]);
    setLastSelectedIndex(null);
    setCurrentIndex(null);
  };

  const handleDeleteSelectedChosen = () => {
    if (!chosenSelectedIndices.length) return;
    setChosen(prev => prev.filter((_, idx) => !chosenSelectedIndices.includes(idx)));
    setChosenSelectedIndices([]);
    setChosenLastSelectedIndex(null);
  };

  const clampEditRange = (start: number, end: number, duration: number): { start: number; end: number } => {
    if (!Number.isFinite(duration) || duration <= MIN_TRIM_SECONDS) {
      return { start: 0, end: MIN_TRIM_SECONDS };
    }

    const maxStart = Math.max(0, duration - MIN_TRIM_SECONDS);
    const nextStart = Math.min(maxStart, Math.max(0, start));
    const nextEnd = Math.min(duration, Math.max(nextStart + MIN_TRIM_SECONDS, end));
    return { start: nextStart, end: nextEnd };
  };

  const getEditTimelineDuration = (): number => {
    if (!Number.isFinite(editDurationSec) || editDurationSec <= 0) return 0;
    const gridStep = getEditGridSeconds();
    const minWindow = gridStep && Number.isFinite(gridStep) ? gridStep : 0;
    return Math.max(editDurationSec, minWindow);
  };

  const getEditGridSeconds = (): number | null => {
    const bpm = Number.parseFloat(editBpmText);
    if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(editStepsPerBeat) || editStepsPerBeat <= 0) {
      return null;
    }
    return 60 / bpm / editStepsPerBeat;
  };

  const clampEditSeconds = (value: number): number => {
    if (!Number.isFinite(value) || editDurationSec <= 0) return 0;
    return Math.min(editDurationSec, Math.max(0, value));
  };

  const snapEditSeconds = (value: number): number => {
    if (!editSnapEnabled) return value;
    const step = getEditGridSeconds();
    if (!step || step <= 0) return value;
    return Math.round(value / step) * step;
  };

  const setEditStart = (value: number) => {
    const next = clampEditRange(snapEditSeconds(value), editEndSec, editDurationSec);
    setEditStartSec(next.start);
    setEditEndSec(next.end);
  };

  const setEditEnd = (value: number) => {
    const next = clampEditRange(editStartSec, snapEditSeconds(value), editDurationSec);
    setEditStartSec(next.start);
    setEditEndSec(next.end);
  };

  const getSecondsFromWaveClientX = (clientX: number) => {
    const viewport = editWaveformViewportRef.current;
    const surface = editWaveformRef.current;
    const duration = getEditTimelineDuration();
    if (!viewport || !surface || duration <= 0) return 0;

    const viewportRect = viewport.getBoundingClientRect();
    const xInViewport = Math.min(viewport.clientWidth, Math.max(0, clientX - viewportRect.left));
    const contentX = xInViewport + viewport.scrollLeft;
    const contentWidth = Math.max(1, surface.clientWidth);
    const normalized = Math.min(1, Math.max(0, contentX / contentWidth));
    return normalized * duration;
  };

  const stopEditPreview = () => {
    if (editPreviewRafRef.current !== null) {
      cancelAnimationFrame(editPreviewRafRef.current);
      editPreviewRafRef.current = null;
    }
    if (editPreviewSourceRef.current) {
      try {
        editPreviewSourceRef.current.stop();
      } catch {
      }
      editPreviewSourceRef.current.disconnect();
      editPreviewSourceRef.current = null;
    }
    editPreviewModeRef.current = 'idle';
  };

  const getLiveEditCursor = () => {
    const ctx = editPreviewCtxRef.current;
    const range = clampEditRange(editStartSec, editEndSec, editDurationSec);
    if (!ctx || editPreviewModeRef.current === 'idle') return clampEditSeconds(editCursorSec);

    const elapsed = Math.max(0, ctx.currentTime - editPreviewStartedAtRef.current);
    const startPoint = editPreviewStartOffsetRef.current;
    if (editPreviewModeRef.current === 'loop') {
      const loopLength = Math.max(MIN_TRIM_SECONDS, range.end - range.start);
      const normalized = ((startPoint - range.start + elapsed) % loopLength + loopLength) % loopLength;
      return range.start + normalized;
    }
    return Math.min(range.end, startPoint + elapsed);
  };

  const startEditNeedleTicker = () => {
    if (editPreviewRafRef.current !== null) {
      cancelAnimationFrame(editPreviewRafRef.current);
      editPreviewRafRef.current = null;
    }
    const tick = () => {
      setEditCursorSec(getLiveEditCursor());
      editPreviewRafRef.current = requestAnimationFrame(tick);
    };
    editPreviewRafRef.current = requestAnimationFrame(tick);
  };

  const ensureEditPreviewContext = async () => {
    if (!editPreviewCtxRef.current) {
      const AudioContextCtor = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextCtor) return null;
      editPreviewCtxRef.current = new AudioContextCtor();
    }
    const ctx = editPreviewCtxRef.current;
    if (ctx?.state === 'suspended') await ctx.resume();
    return ctx;
  };

  const handleLoopPreview = async (forcedCursor?: number) => {
    const buffer = editPreviewBufferRef.current;
    if (!buffer) return;
    const ctx = await ensureEditPreviewContext();
    if (!ctx) return;

    const range = clampEditRange(editStartSec, editEndSec, editDurationSec);
    const current = clampEditSeconds(forcedCursor ?? editCursorSec);
    const startPoint = current >= range.start && current < range.end ? current : range.start;

    stopEditPreview();

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = range.start;
    source.loopEnd = range.end;
    source.connect(ctx.destination);
    source.start(0, startPoint);
    editPreviewSourceRef.current = source;
    editPreviewModeRef.current = 'loop';
    editPreviewStartedAtRef.current = ctx.currentTime;
    editPreviewStartOffsetRef.current = startPoint;
    setEditLoopPlaying(true);
    startEditNeedleTicker();
  };

  const handlePlayOnce = async () => {
    const buffer = editPreviewBufferRef.current;
    if (!buffer) return;
    const ctx = await ensureEditPreviewContext();
    if (!ctx) return;

    const range = clampEditRange(editStartSec, editEndSec, editDurationSec);
    const current = clampEditSeconds(editCursorSec);
    const startPoint = current >= range.start && current < range.end ? current : range.start;
    const duration = Math.max(0, range.end - startPoint);
    if (duration <= 0) return;

    stopEditPreview();

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = false;
    source.connect(ctx.destination);
    source.start(0, startPoint, duration);
    editPreviewSourceRef.current = source;
    editPreviewModeRef.current = 'once';
    editPreviewStartedAtRef.current = ctx.currentTime;
    editPreviewStartOffsetRef.current = startPoint;
    setEditLoopPlaying(true);
    startEditNeedleTicker();

    source.onended = () => {
      if (editPreviewSourceRef.current === source) {
        editPreviewSourceRef.current = null;
      }
      if (editPreviewRafRef.current !== null) {
        cancelAnimationFrame(editPreviewRafRef.current);
        editPreviewRafRef.current = null;
      }
      setEditLoopPlaying(false);
      setEditCursorSec(range.start);
      editPreviewModeRef.current = 'idle';
    };
  };

  const handleStopPreview = () => {
    stopEditPreview();
    setEditLoopPlaying(false);
    setEditCursorSec(clampEditRange(editStartSec, editEndSec, editDurationSec).start);
  };

  const handleStopAllAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    setNowPlayingName(null);
    setPlayerCurrentTime(0);
    setPlayerIsPlaying(false);
    cancelScheduledPreview();
    stopEditPreview();
    setEditLoopPlaying(false);
    setEditCursorSec(0);
  };

  const handleResetEditRange = async () => {
    if (editTargetIndex !== null) {
      const current = chosen[editTargetIndex];
      const originalPath = current?.originalPath;
      if (current && originalPath && originalPath !== current.path) {
        stopEditPreview();
        setEditLoopPlaying(false);

        const restoredSample: Sample = {
          ...current,
          path: originalPath,
          size: Number.isFinite(current.originalSize) ? Number(current.originalSize) : current.size,
          duration: Number.isFinite(current.originalDuration) ? Number(current.originalDuration) : current.duration,
          sampleRate: Number.isFinite(current.originalSampleRate) ? Number(current.originalSampleRate) : current.sampleRate,
          bitDepth: Number.isFinite(current.originalBitDepth) ? Number(current.originalBitDepth) : current.bitDepth,
          channels: Number.isFinite(current.originalChannels) ? Number(current.originalChannels) : current.channels,
          sourceKind: 'file',
          sourceAllPath: undefined,
          sourceOffset: undefined,
          sourceLength: undefined,
        };

        setChosen(prev => prev.map((sample, idx) => (idx === editTargetIndex ? restoredSample : sample)));

        const restoredDuration = Number.isFinite(restoredSample.duration)
          ? Number(restoredSample.duration)
          : editDurationSec;
        const restoredFsPath = toFsPath(restoredSample.path);
        setEditSourcePath(restoredFsPath);
        setEditDurationSec(restoredDuration);
        setEditStartSec(0);
        setEditEndSec(Math.max(MIN_TRIM_SECONDS, restoredDuration));
        setEditCursorSec(0);

        const playbackPath = await resolvePlaybackPath(restoredSample);
        if (playbackPath) setEditPreviewPath(playbackPath);
        setExportMessage(`Restored original source for "${restoredSample.name}" in Export list.`);
        setEditMessage('Restored original sample.');
        return;
      }
    }

    const fullEnd = Math.max(MIN_TRIM_SECONDS, editDurationSec);
    stopEditPreview();
    setEditLoopPlaying(false);
    setEditStartSec(0);
    setEditEndSec(fullEnd);
    setEditCursorSec(0);
  };

  const setCursorFromWaveClientX = (clientX: number) => {
    const next = clampEditSeconds(getSecondsFromWaveClientX(clientX));
    setEditCursorSec(next);
    if (editLoopPlaying && editPreviewModeRef.current === 'loop') {
      void handleLoopPreview(next);
    }
  };

  const closeEditDialog = () => {
    stopEditPreview();
    if (editPreviewCtxRef.current) {
      void editPreviewCtxRef.current.close();
      editPreviewCtxRef.current = null;
    }
    setShowEditDialog(false);
    setEditBusy(false);
    setEditMessage('');
    setEditTargetIndex(null);
    setEditSourcePath(null);
    setEditPreviewPath(null);
    setEditDurationSec(0);
    setEditStartSec(0);
    setEditEndSec(0);
    setEditCursorSec(0);
    editPreviewBufferRef.current = null;
    setEditWaveformBusy(false);
    setEditWaveformVersion(0);
    setEditDragTarget(null);
    setEditLoopPlaying(false);
    setEditSnapEnabled(true);
    setEditZoom(1);
  };

  const handleOpenEditDialog = async () => {
    if (chosenSelectedIndices.length !== 1) {
      setExportMessage('Select exactly one sample in Export list to edit.');
      return;
    }

    const targetIndex = chosenSelectedIndices[0];
    const sample = chosen[targetIndex];
    if (!sample) return;

    if (sample.sourceKind === 'e2s-embedded') {
      if (!window.electronAPI?.extractEmbeddedSampleToTemp) {
        setExportMessage('Cannot edit embedded samples in this environment.');
        return;
      }
      const extracted = await window.electronAPI.extractEmbeddedSampleToTemp({
        sourceAllPath: sample.sourceAllPath,
        sourceOffset: sample.sourceOffset,
        sourceLength: sample.sourceLength,
        sampleName: sample.name,
      });
      if (!extracted?.ok || !extracted.path) {
        setExportMessage(extracted?.message || 'Failed to extract embedded sample for editing.');
        return;
      }
      const dur = Number.isFinite(extracted.duration) ? Number(extracted.duration) : NaN;
      if (!Number.isFinite(dur) || dur <= MIN_TRIM_SECONDS) {
        setExportMessage('Could not determine sample duration for editing.');
        return;
      }
      const playbackPath = await resolvePlaybackPath(sample);
      if (!playbackPath) {
        setExportMessage('Could not create preview URL for this sample.');
        return;
      }
      setEditMessage('');
      setEditTargetIndex(targetIndex);
      setEditSourcePath(extracted.path);
      setEditPreviewPath(playbackPath);
      setEditDurationSec(dur);
      setEditStartSec(0);
      setEditEndSec(dur);
      setEditCursorSec(0);
      setShowEditDialog(true);
      return;
    }

    const sourcePath = toFsPath(sample.path);
    if (!sourcePath) {
      setExportMessage('This sample does not have an editable filesystem path.');
      return;
    }

    const fallbackDuration =
      Number.isFinite(sample.sampleRate) && Number.isFinite(sample.bitDepth) && Number.isFinite(sample.channels)
        ? sample.size / ((Number(sample.sampleRate) * Number(sample.bitDepth) * Number(sample.channels)) / 8)
        : NaN;
    const resolvedDuration = Number.isFinite(sample.duration)
      ? Number(sample.duration)
      : (Number.isFinite(fallbackDuration) ? fallbackDuration : NaN);
    if (!Number.isFinite(resolvedDuration) || Number(resolvedDuration) <= MIN_TRIM_SECONDS) {
      setExportMessage('Could not determine sample duration for editing.');
      return;
    }

    const playbackPath = await resolvePlaybackPath(sample);
    if (!playbackPath) {
      setExportMessage('Could not create preview URL for this sample.');
      return;
    }

    setEditMessage('');
    setEditTargetIndex(targetIndex);
    setEditSourcePath(sourcePath);
    setEditPreviewPath(playbackPath);
    setEditDurationSec(Number(resolvedDuration));
    setEditStartSec(0);
    setEditEndSec(Number(resolvedDuration));
    setEditCursorSec(0);
    setShowEditDialog(true);
  };

  const handleApplyEdit = async () => {
    if (editTargetIndex === null || !chosen[editTargetIndex]) return;
    if (!editSourcePath) {
      setEditMessage('Missing source file path.');
      return;
    }

    const range = clampEditRange(editStartSec, editEndSec, editDurationSec);
    setEditBusy(true);
    setEditMessage('Applying...');
    try {
      if (!window.electronAPI?.trimAudioFile) {
        setEditMessage('Trim API is not available in this environment.');
        return;
      }
      const result = await window.electronAPI.trimAudioFile({
        sourcePath: editSourcePath,
        startSec: range.start,
        endSec: range.end,
        sampleName: chosen[editTargetIndex].name,
      });

      if (!result?.ok || !result.path) {
        setEditMessage(result?.message || 'Failed to trim sample.');
        return;
      }

      setChosen(prev => prev.map((sample, idx) => {
        if (idx !== editTargetIndex) return sample;
        const originalPath = sample.originalPath || sample.path;
        return {
          ...sample,
          path: result.path as string,
          size: Number.isFinite(result.size) ? Number(result.size) : sample.size,
          duration: Number.isFinite(result.duration) ? Number(result.duration) : (range.end - range.start),
          sampleRate: Number.isFinite(result.sampleRate) ? Number(result.sampleRate) : sample.sampleRate,
          bitDepth: Number.isFinite(result.bitDepth) ? Number(result.bitDepth) : sample.bitDepth,
          channels: Number.isFinite(result.channels) ? Number(result.channels) : sample.channels,
          originalPath,
          originalSize: Number.isFinite(sample.originalSize) ? Number(sample.originalSize) : sample.size,
          originalDuration: Number.isFinite(sample.originalDuration) ? Number(sample.originalDuration) : sample.duration,
          originalSampleRate: Number.isFinite(sample.originalSampleRate) ? Number(sample.originalSampleRate) : sample.sampleRate,
          originalBitDepth: Number.isFinite(sample.originalBitDepth) ? Number(sample.originalBitDepth) : sample.bitDepth,
          originalChannels: Number.isFinite(sample.originalChannels) ? Number(sample.originalChannels) : sample.channels,
          sourceKind: 'file',
          sourceAllPath: undefined,
          sourceOffset: undefined,
          sourceLength: undefined,
        };
      }));
      setExportMessage(`Applied trim to "${chosen[editTargetIndex].name}".`);
      closeEditDialog();
    } finally {
      setEditBusy(false);
    }
  };

  // Wire up the always-present audio element to drive mini-player state
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => setPlayerCurrentTime(audio.currentTime);
    const onLoaded = () => setPlayerDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onPlay = () => setPlayerIsPlaying(true);
    const onPause = () => setPlayerIsPlaying(false);
    const onEnded = () => {
      setPlayerIsPlaying(false);
      setPlayerCurrentTime(0);
      setNowPlayingName(null);
    };
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('durationchange', onLoaded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('durationchange', onLoaded);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!showEditDialog || !editPreviewPath) return;

    let cancelled = false;
    const AudioContextCtor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextCtor) return;

    const loadWaveform = async () => {
      setEditWaveformBusy(true);
      try {
        const response = await fetch(editPreviewPath);
        const arrayBuffer = await response.arrayBuffer();
        const context = new AudioContextCtor();
        try {
          const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
          if (!cancelled) {
            editPreviewBufferRef.current = decoded;
            setEditWaveformVersion(v => v + 1);
          }
        } finally {
          void context.close();
        }
      } catch {
        if (!cancelled) {
          setEditMessage('Could not render waveform preview, but trimming still works.');
          editPreviewBufferRef.current = null;
          setEditWaveformVersion(v => v + 1);
        }
      } finally {
        if (!cancelled) setEditWaveformBusy(false);
      }
    };

    void loadWaveform();

    return () => {
      cancelled = true;
    };
  }, [showEditDialog, editPreviewPath]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!showEditDialog || !editDragTarget) return;

    const handlePointerMove = (e: MouseEvent) => {
      const seconds = getSecondsFromWaveClientX(e.clientX);
      if (editDragTarget === 'start') setEditStart(seconds);
      else setEditEnd(seconds);
    };

    const handlePointerUp = () => {
      setEditDragTarget(null);
    };

    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);
    return () => {
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', handlePointerUp);
    };
  }, [showEditDialog, editDragTarget, editStartSec, editEndSec, editDurationSec]); // eslint-disable-line react-hooks/exhaustive-deps

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!showEditDialog) return;
    const canvas = editWaveformCanvasRef.current;
    const surface = editWaveformRef.current;
    const buffer = editPreviewBufferRef.current;
    if (!canvas || !surface || !buffer) return;

    const width = Math.max(1, Math.floor(surface.clientWidth));
    const height = Math.max(1, Math.floor(surface.clientHeight));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;

    const timelineDuration = getEditTimelineDuration();
    if (timelineDuration <= 0) return;

    const channelCount = Math.max(1, buffer.numberOfChannels);
    const channelData = Array.from({ length: channelCount }, (_, i) => buffer.getChannelData(i));
    const sampleSpan = Math.max(1, channelData[0]?.length || 1);
    const sampleWidth = Math.max(1, Math.floor((editDurationSec / timelineDuration) * width));
    const centerY = height * 0.5;
    const amp = height * 0.44;

    ctx.fillStyle = 'rgba(139, 233, 253, 0.92)';
    let prevMin = 0;
    let prevMax = 0;
    for (let x = 0; x < sampleWidth; x++) {
      const from = Math.floor((x / sampleWidth) * sampleSpan);
      const to = Math.floor(((x + 1) / sampleWidth) * sampleSpan);
      let min = 1;
      let max = -1;
      for (let i = from; i < Math.max(from + 1, to); i++) {
        const clampedIdx = Math.min(sampleSpan - 1, i);
        let mixed = 0;
        for (let c = 0; c < channelCount; c++) {
          mixed += channelData[c][clampedIdx] || 0;
        }
        const v = mixed / channelCount;
        if (v < min) min = v;
        if (v > max) max = v;
      }

      // Light smoothing removes harsh visual aliasing on very transient-heavy material.
      const smoothMin = prevMin * 0.28 + min * 0.72;
      const smoothMax = prevMax * 0.28 + max * 0.72;
      prevMin = smoothMin;
      prevMax = smoothMax;

      const y1 = centerY + smoothMin * amp;
      const y2 = centerY + smoothMax * amp;
      const top = Math.min(y1, y2);
      const h = Math.max(1, Math.abs(y2 - y1));
      ctx.fillRect(x, top, 1, h);
    }
  }, [showEditDialog, editWaveformVersion, editZoom, editDurationSec, editBpmText, editStepsPerBeat]); // eslint-disable-line react-hooks/exhaustive-deps

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!showEditDialog || !editLoopPlaying) return;
    const viewport = editWaveformViewportRef.current;
    const surface = editWaveformRef.current;
    if (!viewport || !surface || editDurationSec <= 0) return;

    const cursorX = (clampEditSeconds(editCursorSec) / editDurationSec) * surface.clientWidth;
    const left = viewport.scrollLeft;
    const right = left + viewport.clientWidth;
    const margin = 36;
    if (cursorX < left + margin) {
      viewport.scrollLeft = Math.max(0, cursorX - margin);
    } else if (cursorX > right - margin) {
      viewport.scrollLeft = Math.min(surface.clientWidth, cursorX - viewport.clientWidth + margin);
    }
  }, [showEditDialog, editLoopPlaying, editCursorSec, editDurationSec]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!showEditDialog || !editLoopPlaying || editPreviewModeRef.current !== 'loop') return;
    void handleLoopPreview(getLiveEditCursor());
  }, [showEditDialog, editStartSec, editEndSec]); // eslint-disable-line react-hooks/exhaustive-deps

  const getSampleNumber = (idx: number) => idx + 1;
  const getChosenNumber = (idx: number) => {
    const explicit = chosen[idx]?.slot;
    return Number.isFinite(explicit) ? Number(explicit) : idx + 1 + chosenNumberOffset;
  };

  const getChosenNumberInputValue = (idx: number) => {
    if (Object.prototype.hasOwnProperty.call(chosenSlotDrafts, idx)) {
      return chosenSlotDrafts[idx];
    }
    return String(getChosenNumber(idx));
  };

  const updateChosenNumberByDelta = (idx: number, rawValue: string) => {
    const nextNumber = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(nextNumber)) return;
    if (nextNumber < 1) return;

    const currentNumber = getChosenNumber(idx);
    const delta = nextNumber - currentNumber;
    if (delta !== 0) {
      const hasExplicitSlots = chosen.some(s => Number.isFinite(s.slot));
      if (hasExplicitSlots) {
        setChosen(prev => {
          const baseline = prev.map((s, i) => (Number.isFinite(s.slot) ? Number(s.slot) : (i + 1 + chosenNumberOffset)));
          const next = [...prev];

          for (let i = 0; i < next.length; i++) {
            if (i < idx) {
              next[i] = { ...next[i], slot: Math.max(1, baseline[i]) };
              continue;
            }

            let target = baseline[i] + delta;
            if (i === idx && i > 0) {
              target = Math.max(target, Number(next[i - 1].slot) + 1);
            } else if (i > idx) {
              target = Math.max(target, Number(next[i - 1].slot) + 1);
            }

            next[i] = { ...next[i], slot: Math.max(1, target) };
          }

          return next;
        });
      } else {
        // No explicit slots yet: lock current numbering into explicit slots,
        // then reflow only from edited index onward.
        setChosen(prev => {
          const baseline = prev.map((_, i) => i + 1 + chosenNumberOffset);
          const next = [...prev];

          for (let i = 0; i < next.length; i++) {
            if (i < idx) {
              next[i] = { ...next[i], slot: baseline[i] };
              continue;
            }

            let target = baseline[i] + delta;
            if (i > 0) {
              target = Math.max(target, Number(next[i - 1].slot) + 1);
            }
            next[i] = { ...next[i], slot: Math.max(1, target) };
          }

          return next;
        });
      }
    }
  };

  const commitChosenNumberEdit = (idx: number) => {
    const raw = chosenSlotDrafts[idx];
    if (raw === undefined) return;
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      updateChosenNumberByDelta(idx, trimmed);
    }
    setChosenSlotDrafts(prev => {
      if (!Object.prototype.hasOwnProperty.call(prev, idx)) return prev;
      const next = { ...prev };
      delete next[idx];
      return next;
    });
  };

  useEffect(() => {
    // Clear stale draft entries when the chosen list changes shape/order.
    setChosenSlotDrafts({});
  }, [chosen]);


  // Open folder picker and load .wav files via IPC
  const handleOpenFolder = async () => {
    if (!window.electronAPI) return;
    const files = await window.electronAPI.openFolderDialog();
    if (files && Array.isArray(files)) {
      const newSamples: Sample[] = [];
      for (const f of files) {
        if (f.sampleRate) {
          newSamples.push({ name: f.name, path: f.path, size: f.size, duration: f.duration, sampleRate: f.sampleRate, bitDepth: f.bitDepth, channels: f.channels, category: inferCategoryFromName(f.name, f.duration) });
        } else {
          const converted = await convertExternalAudioToSample(f.path, f.name, f.size);
          if (converted) newSamples.push(converted);
        }
      }
      setSamples(prev => dedupeSamplesByNameAndSize([...prev, ...newSamples]));
    }
  };

  const handleImportE2sAll = async () => {
    if (!window.electronAPI?.openE2sAllDialog) return;
    const result = await window.electronAPI.openE2sAllDialog();
    if (!result || result.canceled) return;
    if (!result.ok) {
      setExportMessage(result.message || 'Failed to import e2s.all file.');
      setShowExportDialog(true);
      return;
    }

    const imported = (result.samples || [])
      .map((s: any) => ({
        slot: s.slot,
        name: s.name,
        path: s.path,
        size: s.size,
        duration: s.duration,
        sampleRate: s.sampleRate,
        bitDepth: s.bitDepth,
        channels: s.channels,
        category: inferCategoryFromName(s.name, s.duration),
        sourceKind: (s.sourceKind === 'e2s-embedded' ? 'e2s-embedded' : 'file') as 'e2s-embedded' | 'file',
        sourceAllPath: s.sourceAllPath,
        sourceOffset: s.sourceOffset,
        sourceLength: s.sourceLength,
      }))
      .sort((a, b) => (a.slot || 0) - (b.slot || 0));

    setSamples(dedupeSamplesByNameAndSize(imported));
    setSelectedIndices([]);
    setLastSelectedIndex(null);
    setCurrentIndex(imported.length ? 0 : null);
    setChosen([]);
    setChosenSelectedIndices([]);
    setChosenLastSelectedIndex(null);
    setChosenNumberOffset(500);
    setExportMessage(result.warnings?.length
      ? `Imported .all into Loaded Samples with ${result.warnings.length} warning(s).`
      : 'Imported .all into Loaded Samples. Add/modify samples and export when ready.');
    setShowExportDialog(false);
  };
  // Add selected sample to chosen list
  // User sample slot logic
  const MAX_USER_SAMPLES = 499;

  // Helper to count user samples
  const getUserSampleCount = (list: Sample[]) => list.filter(s => (s.category === 'User')).length;

  const handleAddToChosen = (idx: number) => {
    if (idx !== null && samples[idx] && !chosen.includes(samples[idx])) {
      // User sample slot logic
      const isUser = samples[idx].category === 'User';
      const userCount = getUserSampleCount(chosen);
      if (isUser && userCount >= MAX_USER_SAMPLES) {
        setExportMessage(`Maximum User Samples reached (max ${MAX_USER_SAMPLES}, slots 501-1000).`);
        return;
      }
      setChosen(prev => [...prev, samples[idx]]);
    }
  };

  // Add all currently selected samples to chosen list
  const handleAddSelectedToChosen = () => {
    let toAdd = selectedIndices.map(i => samples[i]).filter(s => s && !chosen.some(c => c.path === s.path));
    // User sample slot logic
    const userSamples = toAdd.filter(s => s.category === 'User');
    const userCount = getUserSampleCount(chosen);
    if (userSamples.length > 0) {
      const allowed = Math.max(0, MAX_USER_SAMPLES - userCount);
      if (userSamples.length > allowed) {
        setExportMessage(`Only ${allowed} User Samples can be added (max ${MAX_USER_SAMPLES}, slots 501-1000). The rest are skipped.`);
        toAdd = [
          ...toAdd.filter(s => s.category !== 'User'),
          ...userSamples.slice(0, allowed)
        ];
      }
    }
    if (toAdd.length) setChosen(prev => [...prev, ...toAdd]);
  };

  const ELECTRIBE_CATEGORIES = [
    'Analog','Kick','Snare','Clap','HiHat','Cymbal',
    'Hits','Shots','Voice','SE','FX','Tom','Percussion','Phrase','Loop','PCM','User'
  ];
  const GROUP_SORT_DEFAULT_ORDER = [
    'Kick', 'HiHat', 'Snare', 'Clap', 'Percussion', 'Cymbal', 'Tom',
    'Hits', 'Shots', 'Voice', 'Phrase', 'FX', 'Loop', 'PCM', 'SE', 'User', 'Analog'
  ];

  const filteredSamplesWithIndex = samples
    .map((sample, index) => ({ sample, index }))
    .filter(({ sample }) => matchesListFilter(sample, samplesFilterApplied));

  const filteredChosenWithIndex = chosen
    .map((sample, index) => ({ sample, index }))
    .filter(({ sample }) => matchesListFilter(sample, chosenFilterApplied));

  const sortedSamplesWithIndex = applySortToList(filteredSamplesWithIndex, samplesSortField, samplesSortDir);
  const sortedChosenWithIndex = applySortToList(filteredChosenWithIndex, chosenSortField, chosenSortDir, getChosenNumber);

  const handleSamplesSort = (field: SortField) => {
    if (samplesSortField === field) {
      if (samplesSortDir === 'asc') setSamplesSortDir('desc');
      else setSamplesSortField(null);
    } else {
      setSamplesSortField(field);
      setSamplesSortDir('asc');
    }
  };

  const handleChosenSort = (field: SortField) => {
    if (chosenSortField === field) {
      if (chosenSortDir === 'asc') setChosenSortDir('desc');
      else setChosenSortField(null);
    } else {
      setChosenSortField(field);
      setChosenSortDir('asc');
    }
  };

  const openSamplesFilterModal = () => {
    setSamplesFilterDraft(samplesFilterApplied);
    setShowSamplesFilterModal(true);
  };

  const openChosenFilterModal = () => {
    setChosenFilterDraft(chosenFilterApplied);
    setShowChosenFilterModal(true);
  };

  const handleApplySamplesFilter = () => {
    setSamplesFilterApplied(samplesFilterDraft);
    setShowSamplesFilterModal(false);
  };

  const handleApplyChosenFilter = () => {
    setChosenFilterApplied(chosenFilterDraft);
    setShowChosenFilterModal(false);
  };

  const handleResetSamplesFilter = () => {
    setSamplesFilterDraft(DEFAULT_LIST_FILTER);
    setSamplesFilterApplied(DEFAULT_LIST_FILTER);
  };

  const handleResetChosenFilter = () => {
    setChosenFilterDraft(DEFAULT_LIST_FILTER);
    setChosenFilterApplied(DEFAULT_LIST_FILTER);
  };

  const toggleFilterCategory = (
    setter: React.Dispatch<React.SetStateAction<ListFilter>>,
    category: string
  ) => {
    setter(prev => ({
      ...prev,
      categories: prev.categories.includes(category)
        ? prev.categories.filter(value => value !== category)
        : [...prev.categories, category],
    }));
  };

  const getChosenCountByCategory = () => {
    const countByCategory = new Map<string, number>();
    for (const sample of chosen) {
      const cat = (sample.category || 'Hits').trim() || 'Hits';
      countByCategory.set(cat, (countByCategory.get(cat) || 0) + 1);
    }
    return countByCategory;
  };

  // Always start first category at USER_SLOT_START and shift others accordingly.
  const buildAutoCategoryStarts = (order: string[]) => {
    const countByCategory = getChosenCountByCategory();
    let cursor = USER_SLOT_START;
    const starts: Record<string, string> = {};
    for (const cat of order) {
      starts[cat] = String(cursor);
      cursor += countByCategory.get(cat) || 0;
    }
    return starts;
  };

  // Always start first category at USER_SLOT_START and shift others accordingly.
  const normalizeCategoryStarts = (order: string[], desired: Record<string, string>) => {
    const countByCategory = getChosenCountByCategory();
    const firstNonEmptyCategory = order.find(cat => (countByCategory.get(cat) || 0) > 0) || null;
    let cursor = USER_SLOT_START;
    const normalized: Record<string, string> = {};
    for (let i = 0; i < order.length; i++) {
      const cat = order[i];
      const count = countByCategory.get(cat) || 0;
      let start = cursor;
      if (firstNonEmptyCategory && cat === firstNonEmptyCategory) {
        start = USER_SLOT_START;
      } else {
        const parsed = Number.parseInt(String(desired[cat] || ''), 10);
        start = Number.isFinite(parsed) && parsed > 0 ? Math.max(cursor, parsed) : cursor;
      }
      normalized[cat] = String(start);
      if (count > 0) {
        cursor = start + count;
      }
    }
    return normalized;
  };

  const openGroupSortDialog = () => {
    const currentCategories = Array.from(new Set(chosen.map(s => (s.category || 'Hits').trim()).filter(Boolean)));
    const remainingKnown = ELECTRIBE_CATEGORIES.filter(cat => !GROUP_SORT_DEFAULT_ORDER.includes(cat));
    const extras = currentCategories.filter(cat => !GROUP_SORT_DEFAULT_ORDER.includes(cat) && !remainingKnown.includes(cat));
    const defaultOrder = [...GROUP_SORT_DEFAULT_ORDER, ...remainingKnown, ...extras];
    const order = groupOrder.length
      ? [...groupOrder, ...defaultOrder.filter(cat => !groupOrder.includes(cat))]
      : defaultOrder;
    const starts = groupOrder.length
      ? normalizeCategoryStarts(order, { ...buildAutoCategoryStarts(order), ...groupStarts })
      : buildAutoCategoryStarts(order);

    setGroupOrder(order);
    setGroupStarts(starts);
    setDragCategory(null);
    setShowGroupSortDialog(true);
  };

  const moveCategory = (source: string, target: string) => {
    if (!source || !target || source === target) return;
    setGroupOrder(prev => {
      const srcIdx = prev.indexOf(source);
      const dstIdx = prev.indexOf(target);
      if (srcIdx < 0 || dstIdx < 0 || srcIdx === dstIdx) return prev;
      const next = [...prev];
      const [moved] = next.splice(srcIdx, 1);
      next.splice(dstIdx, 0, moved);
      // Dragging categories should always reflow continuously.
      // Intentional gaps are introduced only by manual start edits.
      setGroupStarts(buildAutoCategoryStarts(next));
      return next;
    });
  };

  const applyGroupAndSort = () => {
    if (!chosen.length) {
      setShowGroupSortDialog(false);
      return;
    }

    const orderSet = new Set(groupOrder);
    const fallbackCategories = Array.from(new Set(chosen.map(s => (s.category || 'Hits').trim() || 'Hits'))).filter(cat => !orderSet.has(cat));
    const effectiveOrder = [...groupOrder, ...fallbackCategories];

    const byCategory = new Map<string, Sample[]>();
    for (const cat of effectiveOrder) byCategory.set(cat, []);
    for (const sample of chosen) {
      const cat = (sample.category || 'Hits').trim() || 'Hits';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(sample);
    }

    let cursor = USER_SLOT_START;
    let hasPlacedCategory = false;
    const reordered: Sample[] = [];
    for (let i = 0; i < effectiveOrder.length; i++) {
      const cat = effectiveOrder[i];
      const group = (byCategory.get(cat) || []).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      if (!group.length) continue;

      let start = cursor;
      if (!hasPlacedCategory) {
        start = USER_SLOT_START;
      } else {
        const parsedStart = Number.parseInt(String(groupStarts[cat] || ''), 10);
        start = Number.isFinite(parsedStart) && parsedStart > 0 ? Math.max(cursor, parsedStart) : cursor;
      }

      for (let j = 0; j < group.length; j++) {
        reordered.push({ ...group[j], slot: start + j });
      }
      cursor = start + group.length;
      hasPlacedCategory = true;
    }

    setChosen(reordered);
    setChosenSelectedIndices([]);
    setChosenLastSelectedIndex(null);
    setChosenNumberOffset(USER_SLOT_START - 1);
    setGroupOrder(effectiveOrder);
    setGroupStarts(normalizeCategoryStarts(effectiveOrder, groupStarts));
    setChosenSortField(null);
    setChosenSortDir('asc');
    setShowGroupSortDialog(false);
    setExportMessage('Grouped and sorted chosen samples by category and name.');
  };

  const updateSampleCategory = (idx: number, category: string) => {
    const targetIndices = selectedIndices.includes(idx) && selectedIndices.length > 1 ? selectedIndices : [idx];
    setSamples(prev => prev.map((s, i) => targetIndices.includes(i) ? { ...s, category } : s));
  };

  const updateChosenCategory = (idx: number, category: string) => {
    const targetIndices = chosenSelectedIndices.includes(idx) && chosenSelectedIndices.length > 1 ? chosenSelectedIndices : [idx];
    setChosen(prev => prev.map((s, i) => targetIndices.includes(i) ? { ...s, category } : s));
  };

  const getEffectiveTypeForSample = (sample: Sample): '1-shot' | 'full loop' => {
    if (conversion.type === 'auto') {
      return sample.category === 'Loop' ? 'full loop' : '1-shot';
    }
    return conversion.type;
  };

  const shouldPreserveSourceFormat = (sample: Sample) => {
    if (!exportConvert) return true;
    const rate = Number(sample.sampleRate);
    const bits = Number(sample.bitDepth);
    const channels = Number(sample.channels);
    if (!Number.isFinite(rate) || !Number.isFinite(bits) || !Number.isFinite(channels)) return false;
    return rate < 48000 && bits === 16 && channels === 1;
  };

  const getEffectiveOutputAudio = (sample: Sample) => {
    const preserve = shouldPreserveSourceFormat(sample);
    if (preserve) {
      return {
        sampleRate: sample.sampleRate && sample.sampleRate > 0 ? sample.sampleRate : 44100,
        bitDepth: sample.bitDepth && sample.bitDepth > 0 ? sample.bitDepth : 16,
        channels: sample.channels && sample.channels > 0 ? sample.channels : 1,
        preserved: true,
      };
    }

    return {
      sampleRate: conversion.sampleRate,
      bitDepth: Math.min(conversion.bitDepth, 16),
      channels: conversion.channels,
      preserved: false,
    };
  };

  const calcConvertedSize = (sample: Sample) => {
    if (shouldPreserveSourceFormat(sample)) {
      return sample.size;
    }

    const sourceRate = sample.sampleRate && sample.sampleRate > 0 ? sample.sampleRate : 44100;
    const sourceBitDepth = sample.bitDepth && sample.bitDepth > 0 ? sample.bitDepth : 16;
    const sourceChannels = sample.channels && sample.channels > 0 ? sample.channels : 2;

    const sourceFrameBytes = (sourceBitDepth * sourceChannels) / 8;
    const targetBitDepth = Math.min(conversion.bitDepth, 16);
    const targetFrameBytes = (targetBitDepth * conversion.channels) / 8;
    const rateRatio = conversion.sampleRate / sourceRate;
    const frameRatio = sourceFrameBytes > 0 ? targetFrameBytes / sourceFrameBytes : 1;

    const formatRatio: Record<ConversionSettings['format'], number> = {
      '.wav': 1,
      '.aiff': 1.02,
      '.flac': 0.62,
      '.mp3': 0.2,
      '.ogg': 0.24,
    };

    return sample.size * rateRatio * frameRatio * formatRatio[conversion.format];
  };

  const isElectriberPreset = (c: ConversionSettings): boolean =>
    c.format === ELECTRIBE_PRESET.format &&
    c.sampleRate === ELECTRIBE_PRESET.sampleRate &&
    c.bitDepth === ELECTRIBE_PRESET.bitDepth &&
    c.channels === ELECTRIBE_PRESET.channels &&
    c.type === ELECTRIBE_PRESET.type &&
    c.volume === ELECTRIBE_PRESET.volume;

  const activePreset = isElectriberPreset(conversion) ? ELECTRIBE_PRESET_NAME : 'User';

  const updateConversion = (updater: (prev: ConversionSettings) => ConversionSettings) => {
    setConversion(prev => updater(prev));
  };

  const handleChooseExportDirectory = async () => {
    if (!window.electronAPI?.chooseExportDirectory) return;
    const picked = await window.electronAPI.chooseExportDirectory();
    if (picked) {
      setExportDirectory(picked);
    }
  };

  const handleRunExport = async () => {
    if (!exportDirectory) {
      setExportMessage('Please choose an export directory first.');
      return;
    }

    if (!window.electronAPI?.exportE2sAll) {
      setExportMessage('Export API is not available in this environment.');
      return;
    }

    const finalFileName = exportFileName.trim();
    if (!finalFileName) {
      setExportMessage('Please enter an export file name.');
      return;
    }

    if (!chosen.length) {
      setExportMessage('No chosen samples to export.');
      return;
    }

    if (ramLimitApplies && usedSpace > MAX_SAMPLE_RAM_BYTES) {
      setExportMessage(`Export blocked: sample memory exceeds ${(MAX_SAMPLE_RAM_BYTES / 1000000).toFixed(2)} MB.`);
      return;
    }

    setExportBusy(true);
    setExportMessage('Export in progress...');
    try {
      const payload = {
        outputDirectory: exportDirectory,
        fileName: finalFileName,
        exportMode,
        shouldConvert: exportConvert,
        conversion,
        samples: chosen.map((s, i) => ({
          slot: getChosenNumber(i),
          name: s.name,
          path: s.path,
          size: s.size,
          category: s.category,
          exportType: getEffectiveTypeForSample(s),
          sourceKind: s.sourceKind,
          sourceAllPath: s.sourceAllPath,
          sourceOffset: s.sourceOffset,
          sourceLength: s.sourceLength,
        })),
      };

      const result = await window.electronAPI.exportE2sAll(payload);
      if (!result?.ok) {
        setExportMessage(result?.message || 'Export failed.');
        return;
      }

      const warnings = result.warnings?.length ? ` Warnings: ${result.warnings.length}.` : '';
      const summary = result.summary || {};
      const writtenSummary =
        Number.isFinite(summary.writtenSamples) && Number.isFinite(summary.requestedSamples)
          ? ` Written: ${summary.writtenSamples}/${summary.requestedSamples}.`
          : '';
      const slotSummary =
        Number.isFinite(summary.firstWrittenSlot) && Number.isFinite(summary.lastWrittenSlot)
          ? ` Slots: ${summary.firstWrittenSlot}-${summary.lastWrittenSlot}.`
          : '';
      if (exportMode === 'placeholder-sort') {
        setExportMessage(`Sorted samples exported to ${result.outPath}.${warnings}`);
      } else {
        setExportMessage(`Exported to ${result.outPath}.${writtenSummary}${slotSummary}${warnings}`);
      }
    } finally {
      setExportBusy(false);
    }
  };

  // Add all currently visible samples from the import list to chosen list
  const handleAddAllToChosen = () => {
    let toAdd = sortedSamplesWithIndex
      .map(({ sample }) => sample)
      .filter(s => !chosen.some(c => c.path === s.path));

    const userSamples = toAdd.filter(s => s.category === 'User');
    const userCount = getUserSampleCount(chosen);
    if (userSamples.length > 0) {
      const allowed = Math.max(0, MAX_USER_SAMPLES - userCount);
      if (userSamples.length > allowed) {
        setExportMessage(`Only ${allowed} User Samples can be added (max ${MAX_USER_SAMPLES}, slots 501-1000). The rest are skipped.`);
        toAdd = [
          ...toAdd.filter(s => s.category !== 'User'),
          ...userSamples.slice(0, allowed)
        ];
      }
    }
    if (toAdd.length) setChosen(prev => [...prev, ...toAdd]);
  };

  const handleSelectAllSamples = () => {
    const visibleIndices = sortedSamplesWithIndex.map(({ index }) => index);
    setActiveList('samples');
    setSelectedIndices(visibleIndices);
    setLastSelectedIndex(visibleIndices.length ? visibleIndices[visibleIndices.length - 1] : null);
    setCurrentIndex(visibleIndices.length ? visibleIndices[0] : null);
  };

  const handleSelectAllChosen = () => {
    const visibleIndices = sortedChosenWithIndex.map(({ index }) => index);
    setActiveList('chosen');
    setChosenSelectedIndices(visibleIndices);
    setChosenLastSelectedIndex(visibleIndices.length ? visibleIndices[visibleIndices.length - 1] : null);
  };

  // Keyboard navigation and hotkey
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement> | KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      if (tagName === 'input' || tagName === 'select' || tagName === 'textarea') return;

      if (e.key === 'ArrowDown') {
        if (activeList === 'chosen') {
          if (!chosen.length) return;
          const last = chosenSelectedIndices.length ? chosenSelectedIndices[chosenSelectedIndices.length - 1] : 0;
          const next = Math.min(chosen.length - 1, last + 1);
          handleChosenMultiSelect(next, undefined);
        } else {
          if (!samples.length) return;
          const last = selectedIndices.length ? selectedIndices[selectedIndices.length - 1] : -1;
          const next = Math.min(samples.length - 1, last + 1);
          setActiveList('samples');
          setSelectedIndices([next]);
          setLastSelectedIndex(next);
          setCurrentIndex(next);
          cancelScheduledPreview();
          void playSample(samples[next]);
        }
      } else if (e.key === 'ArrowUp') {
        if (activeList === 'chosen') {
          if (!chosen.length) return;
          const last = chosenSelectedIndices.length ? chosenSelectedIndices[chosenSelectedIndices.length - 1] : 0;
          const prevIdx = Math.max(0, last - 1);
          handleChosenMultiSelect(prevIdx, undefined);
        } else {
          if (!samples.length) return;
          const last = selectedIndices.length ? selectedIndices[selectedIndices.length - 1] : 0;
          const prevIdx = Math.max(0, last - 1);
          setActiveList('samples');
          setSelectedIndices([prevIdx]);
          setLastSelectedIndex(prevIdx);
          setCurrentIndex(prevIdx);
          cancelScheduledPreview();
          void playSample(samples[prevIdx]);
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const sample = getCurrentSampleForActiveList();
        if (sample) {
          cancelScheduledPreview();
          void playSample(sample);
        }
      } else if (e.key === 'Enter') {
        if (activeList === 'samples' && selectedIndices.length) handleAddSelectedToChosen();
      } else if (e.key === 'Delete') {
        if (activeList === 'chosen') {
          handleDeleteSelectedChosen();
        } else {
          handleDeleteSelectedSamples();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown as any);
    return () => window.removeEventListener('keydown', handleKeyDown as any);
  }, [
    activeList,
    chosen,
    chosenSelectedIndices,
    currentIndex,
    samples,
    selectedIndices,
  ]);
  /* eslint-enable react-hooks/exhaustive-deps */

  // Scroll selected sample into view when navigating with arrow keys
  useEffect(() => {
    if (selectedIndices.length > 0 && sampleListContainerRef.current) {
      const idx = selectedIndices[selectedIndices.length - 1];
      const el = sampleListContainerRef.current.querySelector(`[data-sampleindex="${idx}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndices]);

  useEffect(() => {
    return () => cancelScheduledPreview();
  }, []);

  const usedSpace = chosen.reduce((acc, s) => acc + calcConvertedSize(s), 0);
  const maxSpace = MAX_SAMPLE_RAM_BYTES;
  const isOverRam = ramLimitApplies && usedSpace > maxSpace;
  const headroomBytes = maxSpace - usedSpace;
  // (removed duplicate declaration)

  // Show warning if user adds more than 499 samples in e2s-all mode
  useEffect(() => {
    if (exportMode === 'e2s-all' && chosen.length > MAX_USER_SAMPLES) {
      setShowSampleLimitWarning(true);
    }
  }, [chosen.length, exportMode]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const version = await window.electronAPI?.getAppVersion?.();
        if (!cancelled && typeof version === 'string' && version.trim()) {
          setAppVersion(version.trim());
        }
      } catch {
        // Keep the label hidden if version lookup fails.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSampleLimitAction = (action: 'keep499' | 'sortonly') => {
    if (action === 'keep499') {
      setChosen(prev => prev.slice(0, MAX_USER_SAMPLES));
      setShowSampleLimitWarning(false);
    } else if (action === 'sortonly') {
      setExportMode('placeholder-sort');
      setShowSampleLimitWarning(false);
    }
  };

  return (
    <div className="App">
      <header className="App-header">
        <div className="main-content fixed-lists">
          {/* Left Panel */}
          <div className="list-panel">
            <div className="panel-header panel-header-import">
              {appVersion ? <div className="app-version-label">v{appVersion}</div> : null}
              <span className="list-title">Import</span>
              <div className="panel-actions">
                <button className="export-btn" onClick={handleImportE2sAll}>Import .all</button>
                <button className="export-btn" onClick={handleOpenFolder} title="Click to add samples or drag & drop">Import Audio</button>
                <button className="clear-btn" onClick={handleDeleteSelectedSamples} disabled={selectedIndices.length === 0}>Delete</button>
                <button className="clear-btn" onClick={() => { setSamples([]); setSelectedIndices([]); setLastSelectedIndex(null); setCurrentIndex(null); }}>Clear</button>
              </div>
            </div>
            <div className="panel-add-row">
              <div className="panel-add-row-left">
                <button
                  className="add-samples-btn"
                  onClick={handleAddSelectedToChosen}
                  disabled={selectedIndices.length === 0}
                >
                  Add Sample{selectedIndices.length > 1 ? 's' : ''}{selectedIndices.length > 0 ? ` (${selectedIndices.length})` : ''} →
                </button>
                <button
                  className="add-all-btn"
                  onClick={handleAddAllToChosen}
                  disabled={samples.length === 0}
                >
                  Add all →
                </button>
                <button
                  className="select-all-btn"
                  onClick={handleSelectAllSamples}
                  disabled={sortedSamplesWithIndex.length === 0}
                >
                  Select All
                </button>
              </div>
              <div className="panel-add-row-actions">
                <button
                  className="filter-btn"
                  onClick={openSamplesFilterModal}
                  title="Filter import list"
                >
                  Filter
                </button>
              </div>
            </div>
            <div className="sort-bar">
              {(['name', 'category', 'slot', 'duration', 'size'] as SortField[]).map(field => (
                <button
                  key={field}
                  className={`sort-btn${samplesSortField === field ? ' active' : ''}`}
                  onClick={() => handleSamplesSort(field)}
                  title={samplesSortField === field ? (samplesSortDir === 'asc' ? 'Currently ascending — click for descending' : 'Currently descending — click to clear') : 'Sort ascending'}
                >
                  {field === 'duration' ? 'Length' : field === 'slot' ? 'Slot #' : field.charAt(0).toUpperCase() + field.slice(1)}
                  {samplesSortField === field && <span className="sort-arrow">{samplesSortDir === 'asc' ? ' ▲' : ' ▼'}</span>}
                </button>
              ))}
              <span className="sort-items-count" aria-label="Import item count">
                {sortedSamplesWithIndex.length} Item{sortedSamplesWithIndex.length === 1 ? '' : 's'}
              </span>
            </div>
            <div 
              ref={sampleListContainerRef}
              className="scrollable list-area"
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              title="Click to add samples or drag & drop here"
            >
              {filteredSamplesWithIndex.length === 0 ? (
                <div className="drop-message-center">
                  <div className="drop-message-text">Drag &amp; drop files / folders here</div>
                  {samples.length > 0 && isFilterActive(samplesFilterApplied) && (
                    <div className="drop-filter-notice">No items match the current filter</div>
                  )}
                </div>
              ) : (
                <ul className="sample-list">
                  {sortedSamplesWithIndex.map(({ sample: s, index: i }) => (
                    <li
                      key={i}
                      data-sampleindex={i}
                      className={selectedIndices.includes(i) ? 'selected' : ''}
                      tabIndex={0}
                      style={{ cursor: 'pointer' }}
                      onClick={e => handleSelect(i, e, 'delayed')}
                      onDoubleClick={() => {
                        cancelScheduledPreview();
                        handleAddToChosen(i);
                      }}
                    >
                      <div className="file-row">
                        <div className="sample-leading">
                          <span className="sample-index">{getSampleNumber(i)}</span>
                          <span className="sample-name">{s.name}</span>
                        </div>
                        <select
                          className="sample-category-select"
                          value={s.category ?? 'Hits'}
                          onClick={e => e.stopPropagation()}
                          onChange={e => { e.stopPropagation(); updateSampleCategory(i, e.target.value); }}
                        >
                          {ELECTRIBE_CATEGORIES.map(cat => (
                            <option key={cat} value={cat}>{cat}</option>
                          ))}
                        </select>
                      </div>
                      <div className="file-info">
                        <span>{Number.isFinite(s.slot) ? `Slot ${Number(s.slot)}` : 'Slot --'}</span>
                        <span>{s.sampleRate ? `${(s.sampleRate / 1000).toFixed(1)}kHz` : '--.-kHz'}</span>
                        <span>{s.bitDepth ? `${s.bitDepth}bit` : '--bit'}</span>
                        <span>{s.channels ? (s.channels === 1 ? 'Mono' : 'Stereo') : '--'}</span>
                        <span>{formatDuration(s.duration)}</span>
                        <span>{(s.size / 1024).toFixed(1)} KB</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {/* Right Panel */}
          <div className="list-panel">
            <div className="panel-header">
              <span className="list-title">Export</span>
              <div className="panel-actions">
                <button className="clear-btn" onClick={handleDeleteSelectedChosen} disabled={chosenSelectedIndices.length === 0}>Delete</button>
                <button className="clear-btn" onClick={() => { setChosen([]); setChosenSelectedIndices([]); setChosenLastSelectedIndex(null); }}>Clear</button>
                <button className="export-btn" onClick={() => { setExportMessage(''); setShowExportDialog(true); }}>Export</button>
              </div>
            </div>
            <div className="panel-add-row panel-add-row-right">
              <div className="panel-add-row-left">
                <button
                  className="group-btn"
                  onClick={() => { void handleOpenEditDialog(); }}
                  title="Trim selected sample"
                  disabled={chosenSelectedIndices.length !== 1}
                >
                  Edit
                </button>
                <button
                  className="select-all-btn"
                  onClick={handleSelectAllChosen}
                  disabled={sortedChosenWithIndex.length === 0}
                >
                  Select All
                </button>
              </div>
              <div className="panel-add-row-actions">
                <button
                  className="filter-btn"
                  onClick={openChosenFilterModal}
                  title="Filter export list"
                >
                  Filter
                </button>
                <button
                  className="group-btn"
                  onClick={openGroupSortDialog}
                  title="Group and sort chosen samples"
                >
                  Group and sort
                </button>
              </div>
            </div>
            <div className="sort-bar">
              {(['name', 'category', 'slot', 'duration', 'size'] as SortField[]).map(field => (
                <button
                  key={field}
                  className={`sort-btn${chosenSortField === field ? ' active' : ''}`}
                  onClick={() => handleChosenSort(field)}
                  title={chosenSortField === field ? (chosenSortDir === 'asc' ? 'Currently ascending — click for descending' : 'Currently descending — click to clear') : 'Sort ascending'}
                >
                  {field === 'duration' ? 'Length' : field === 'slot' ? 'Slot #' : field.charAt(0).toUpperCase() + field.slice(1)}
                  {chosenSortField === field && <span className="sort-arrow">{chosenSortDir === 'asc' ? ' ▲' : ' ▼'}</span>}
                </button>
              ))}
              <span className="sort-items-count" aria-label="Export item count">
                {sortedChosenWithIndex.length} Item{sortedChosenWithIndex.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="scrollable list-area">
              {filteredChosenWithIndex.length === 0 ? (
                <div className="drop-message-center">
                  <div className="drop-message-text">Add samples from the Import list</div>
                  {chosen.length > 0 && isFilterActive(chosenFilterApplied) && (
                    <div className="drop-filter-notice">No items match the current filter</div>
                  )}
                </div>
              ) : (
                <ul className="chosen-list">
                    {sortedChosenWithIndex.map(({ sample: s, index: i }) => {
                      const output = getEffectiveOutputAudio(s);
                      return (
                        <li
                          key={i}
                          className={chosenSelectedIndices.includes(i) ? 'selected' : ''}
                          style={{ cursor: 'pointer' }}
                          onClick={e => handleChosenMultiSelect(i, e)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') handleChosenMultiSelect(i, e);
                          }}
                          tabIndex={0}
                        >
                          <div className="file-row">
                            <div className="sample-leading">
                              <input
                                className="sample-index-input"
                                type="text"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                value={getChosenNumberInputValue(i)}
                                onClick={e => e.stopPropagation()}
                                onFocus={e => e.currentTarget.select()}
                                onChange={e => {
                                  const sanitized = e.target.value.replace(/[^0-9]/g, '');
                                  setChosenSlotDrafts(prev => ({ ...prev, [i]: sanitized }));
                                }}
                                onBlur={() => {
                                  if (chosenSlotSkipBlurCommitRef.current[i]) {
                                    delete chosenSlotSkipBlurCommitRef.current[i];
                                    return;
                                  }
                                  commitChosenNumberEdit(i);
                                }}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') {
                                    chosenSlotSkipBlurCommitRef.current[i] = true;
                                    commitChosenNumberEdit(i);
                                    (e.target as HTMLInputElement).blur();
                                  }
                                  if (e.key === 'Escape') {
                                    chosenSlotSkipBlurCommitRef.current[i] = true;
                                    setChosenSlotDrafts(prev => {
                                      if (!Object.prototype.hasOwnProperty.call(prev, i)) return prev;
                                      const next = { ...prev };
                                      delete next[i];
                                      return next;
                                    });
                                    (e.target as HTMLInputElement).blur();
                                  }
                                }}
                                aria-label={`Sample number ${i + 1}`}
                              />
                              <span className="sample-name">{s.name}</span>
                            </div>
                            <select
                              className="sample-category-select"
                              value={s.category ?? 'Hits'}
                              onClick={e => e.stopPropagation()}
                              onChange={e => { e.stopPropagation(); updateChosenCategory(i, e.target.value); }}
                            >
                              {ELECTRIBE_CATEGORIES.map(cat => (
                                <option key={cat} value={cat}>{cat}</option>
                              ))}
                            </select>
                            <button
                              className="delete-btn"
                              style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}
                              onClick={e => {
                                e.stopPropagation();
                                setChosen(prev => prev.filter((_, idx) => idx !== i));
                              }}
                              title="Remove from chosen"
                            >
                              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <rect x="5" y="7" width="1.5" height="7" rx="0.75" fill="#d32f2f"/>
                                <rect x="9.25" y="7" width="1.5" height="7" rx="0.75" fill="#d32f2f"/>
                                <rect x="13.5" y="7" width="1.5" height="7" rx="0.75" fill="#d32f2f"/>
                                <rect x="4" y="5" width="12" height="2" rx="1" fill="#bdbdbd"/>
                                <rect x="7" y="2" width="6" height="2" rx="1" fill="#bdbdbd"/>
                                <rect x="2" y="5" width="16" height="2" rx="1" fill="#bdbdbd" fillOpacity="0.3"/>
                                <rect x="5" y="7" width="10" height="9" rx="2" stroke="#bdbdbd" strokeWidth="1.5"/>
                              </svg>
                            </button>
                          </div>
                          <div className="file-info">
                            <span>{`${(output.sampleRate / 1000).toFixed(1)}kHz`}</span>
                            <span>{`${output.bitDepth}bit`}</span>
                            <span>{output.channels === 1 ? 'Mono' : 'Stereo'}</span>
                            <span>{formatDuration(s.duration)}</span>
                            <span>{conversion.format}</span>
                            <span>{getEffectiveTypeForSample(s)}</span>
                            <span>{conversion.volume}</span>
                            <span className="simulated-size">
                              {(calcConvertedSize(s) / 1024).toFixed(1)} KB {output.preserved ? 'preserved' : 'simulated'}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
              )}
            </div>
          </div>
        </div> {/* <-- closes .main-content fixed-lists */}
        <div className="footer-bar">
          <div className="footer-actions">
            <button
              className="footer-btn paypal"
              onClick={() => {
                window.open('https://www.paypal.com/donate/?business=U27PB86V87C8Q&no_recurring=0&currency_code=EUR', '_blank', 'noopener,noreferrer');
              }}
            >
              Donate
            </button>
            <button className="footer-btn" onClick={() => setShowHelpModal(true)}>Help</button>
            {nowPlayingName ? (
              <div className="mini-player">
                <span className="mini-player-name" title={nowPlayingName}>{nowPlayingName}</span>
                <button
                  className="mini-player-playpause"
                  onClick={() => {
                    if (!audioRef.current) return;
                    if (playerIsPlaying) { audioRef.current.pause(); }
                    else { void audioRef.current.play(); }
                  }}
                  title={playerIsPlaying ? 'Pause' : 'Play'}
                >{playerIsPlaying ? '⏸' : '▶'}</button>
                <input
                  type="range"
                  className="mini-player-scrub"
                  min={0}
                  max={playerDuration || 1}
                  step={0.01}
                  value={playerCurrentTime}
                  style={{ '--pct': `${((playerCurrentTime / (playerDuration || 1)) * 100).toFixed(1)}%` } as React.CSSProperties}
                  onChange={e => {
                    const t = Number(e.target.value);
                    setPlayerCurrentTime(t);
                    if (audioRef.current) audioRef.current.currentTime = t;
                  }}
                />
                <span className="mini-player-time">
                  {formatPlayerTime(playerCurrentTime)}{playerDuration > 0 ? ` / ${formatPlayerTime(playerDuration)}` : ''}
                </span>
              </div>
            ) : (
              <div className="mini-player mini-player-idle">
                <span className="mini-player-idle-label">No preview playing</span>
              </div>
            )}
            <button
              className="stop-all-btn"
              onClick={handleStopAllAudio}
              title="Stop all audio"
              aria-label="Stop all audio"
            >&#9632;</button>
          </div>
          <div className={`footer-ram${isOverRam ? ' over-limit' : ''}`}>
            <div className="footer-ram-text">
              Used: {(usedSpace / 1000000).toFixed(2)} MB / {(maxSpace / 1000000).toFixed(2)} MB
              <span className="headroom-label">
                {' '}| Headroom: {(headroomBytes / 1000000).toFixed(2)} MB
              </span>
            </div>
            <div className="footer-ram-track" aria-label="RAM usage" style={{marginLeft: 12, width: 180}}>
              <div
                className={`footer-ram-fill${isOverRam ? ' over-limit' : ''}`}
                style={{ width: `${Math.min(100, Math.max(0, (usedSpace / maxSpace) * 100))}%` }}
              />
            </div>
          </div>
        </div>
              {showSampleLimitWarning && (
                <div className="modal-bg" style={{zIndex: 2000}}>
                  <div className="modal" style={{maxWidth: 420, textAlign: 'center'}}>
                    <h2>Sample Limit Exceeded</h2>
                    <p style={{marginBottom: 18}}>
                      Only 499 user samples can be exported to Electribe.<br/>
                      You have added {chosen.length} samples.
                    </p>
                    <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
                      <button className="export-btn" onClick={() => handleSampleLimitAction('keep499')}>Keep first 499 samples</button>
                      <button className="export-btn" onClick={() => handleSampleLimitAction('sortonly')}>Switch to sort only mode (no limit)</button>
                    </div>
                  </div>
                </div>
              )}
        <audio ref={audioRef} className="audio-player" />
        {showEditDialog && (
          <div className="modal-bg" onClick={closeEditDialog}>
            <div className="modal edit-modal" onClick={e => e.stopPropagation()}>
              <h2>Edit Sample</h2>

              <div className="edit-transport-row">
                <button className="edit-transport-btn" onClick={() => { void handlePlayOnce(); }} disabled={editLoopPlaying} title="Play once">
                  ▶
                </button>
                <button className="edit-transport-btn" onClick={() => { void handleLoopPreview(); }} disabled={editLoopPlaying} title="Loop between start and end">
                  ↻
                </button>
                <button className="edit-transport-btn" onClick={handleStopPreview} title="Stop and reset">
                  ■
                </button>
                <button className="clear-btn" onClick={() => { void handleResetEditRange(); }} title="Reset to original length or restore original source">
                  Reset
                </button>
              </div>

              <div className="edit-grid-row">
                <div className="edit-grid-field">
                  <label>BPM</label>
                  <input
                    value={editBpmText}
                    onChange={e => setEditBpmText(e.target.value)}
                    placeholder="Tempo"
                  />
                </div>
                <div className="edit-grid-field">
                  <label>Grid</label>
                  <select
                    value={editStepsPerBeat}
                    onChange={e => setEditStepsPerBeat(Number(e.target.value))}
                  >
                    <option value={1}>1/1 beat</option>
                    <option value={2}>1/2 beat</option>
                    <option value={4}>1/4 beat</option>
                    <option value={8}>1/8 beat</option>
                    <option value={16}>1/16 beat</option>
                    <option value={32}>1/32 beat</option>
                  </select>
                </div>
                <label className="export-checkbox edit-grid-snap-toggle">
                  <input
                    type="checkbox"
                    checked={editSnapEnabled}
                    onChange={e => setEditSnapEnabled(e.target.checked)}
                  />
                  <span>Snap to grid</span>
                </label>
              </div>

              <div className="edit-range-block">
                <div className="waveform-wrap">
                  <div className="waveform-toolbar">
                    <div className="waveform-zoom-controls">
                      <button
                        className="edit-zoom-btn"
                        onClick={() => setEditZoom(z => Math.max(1, Number((z / 1.5).toFixed(2))))}
                        disabled={editZoom <= 1}
                        title="Zoom out"
                      >
                        -
                      </button>
                      <span className="waveform-zoom-label">{editZoom.toFixed(2)}x</span>
                      <button
                        className="edit-zoom-btn"
                        onClick={() => setEditZoom(z => Math.min(40, Number((z * 1.5).toFixed(2))))}
                        disabled={editZoom >= 40}
                        title="Zoom in"
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <div ref={editWaveformViewportRef} className="waveform-viewport">
                    <div
                      ref={editWaveformRef}
                      className="waveform-surface"
                      style={{
                        ['--zoom' as any]: editZoom,
                        ['--step-pct' as any]: `${(() => {
                          const duration = getEditTimelineDuration();
                          const step = getEditGridSeconds();
                          return duration > 0 && step ? Math.max(0.1, (step / duration) * 100) : 0;
                        })()}%`,
                        ['--bar-step-pct' as any]: `${(() => {
                          const duration = getEditTimelineDuration();
                          const step = getEditGridSeconds();
                          return duration > 0 && step ? Math.max(0.1, ((step * editStepsPerBeat) / duration) * 100) : 0;
                        })()}%`,
                        ['--start-pct' as any]: `${(() => {
                          const duration = getEditTimelineDuration();
                          return duration > 0 ? (editStartSec / duration) * 100 : 0;
                        })()}%`,
                        ['--end-pct' as any]: `${(() => {
                          const duration = getEditTimelineDuration();
                          return duration > 0 ? (editEndSec / duration) * 100 : 100;
                        })()}%`,
                        ['--cursor-pct' as any]: `${(() => {
                          const duration = getEditTimelineDuration();
                          return duration > 0 ? (editCursorSec / duration) * 100 : 0;
                        })()}%`,
                      }}
                      onMouseDown={e => {
                        setCursorFromWaveClientX(e.clientX);
                      }}
                    >
                      <div className={`waveform-grid${getEditGridSeconds() ? ' visible' : ''}`} />
                      <canvas ref={editWaveformCanvasRef} className="waveform-canvas" />
                      {(!editPreviewBufferRef.current || editWaveformBusy) && (
                        <div className="waveform-empty">{editWaveformBusy ? 'Analyzing waveform...' : 'Waveform unavailable'}</div>
                      )}

                      <div className="waveform-selection" />
                      <div className="waveform-cursor" />
                      <div
                        className="waveform-handle waveform-handle-start"
                        onMouseDown={e => {
                          e.stopPropagation();
                          setEditDragTarget('start');
                          setEditStart(getSecondsFromWaveClientX(e.clientX));
                        }}
                      />
                      <div
                        className="waveform-handle waveform-handle-end"
                        onMouseDown={e => {
                          e.stopPropagation();
                          setEditDragTarget('end');
                          setEditEnd(getSecondsFromWaveClientX(e.clientX));
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div className="edit-range-stats">
                  <span>Original: {formatDuration(editDurationSec)}</span>
                  <span>Trimmed: {formatDuration(Math.max(0, editEndSec - editStartSec))}</span>
                  <span>
                    Start {editStartSec.toFixed(3)}s | End {editEndSec.toFixed(3)}s
                  </span>
                </div>
              </div>

              {editMessage && <div className="export-message">{editMessage}</div>}

              <div className="export-actions-row">
                <button className="close-btn" onClick={closeEditDialog}>Cancel</button>
                <button className="export-btn" disabled={editBusy} onClick={() => { void handleApplyEdit(); }}>
                  {editBusy ? 'Applying...' : 'Apply'}
                </button>
              </div>
            </div>
          </div>
        )}
        {/* Export Modal */}
        {showExportDialog && (
          <div className="modal-bg" onClick={() => setShowExportDialog(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <h2>Export</h2>
              <div className="settings-row settings-row-compact settings-row-top">
                <label>Mode:</label>
                <select value={exportMode} onChange={e => setExportMode(e.target.value as typeof exportMode)}>
                  <option value="e2s-all">e2s.all (Electribe 2s)</option>
                  <option value="placeholder-sort" title="Sort and Categorize samples locally">Just sort</option>
                </select>
              </div>

              <div className="settings-row">
                <label>Preset:</label>
                <select
                  value={activePreset}
                  onChange={e => {
                    if (e.target.value === ELECTRIBE_PRESET_NAME) {
                      setConversion(ELECTRIBE_PRESET);
                    }
                  }}
                >
                  <option value={ELECTRIBE_PRESET_NAME}>{ELECTRIBE_PRESET_NAME}</option>
                  <option value="User">User</option>
                </select>
              </div>

              <div className="settings-row">
                <label>Format:</label>
                <select
                  value={conversion.format}
                  onChange={e => updateConversion(c => ({ ...c, format: e.target.value as ConversionSettings['format'] }))}
                >
                  <option value=".wav">.wav</option>
                  <option value=".mp3">.mp3</option>
                  <option value=".flac">.flac</option>
                  <option value=".aiff">.aiff</option>
                  <option value=".ogg">.ogg</option>
                </select>
              </div>

              <div className="settings-row">
                <label>Sample Rate:</label>
                <select value={conversion.sampleRate} onChange={e => updateConversion(c => ({ ...c, sampleRate: Number(e.target.value) }))}>
                  <option value={44100}>44.1 kHz</option>
                  <option value={48000}>48 kHz</option>
                </select>
              </div>

              <div className="settings-row">
                <label>Bit Depth:</label>
                <select value={conversion.bitDepth} onChange={e => updateConversion(c => ({ ...c, bitDepth: Number(e.target.value) }))}>
                  <option value={16}>16 bit</option>
                  <option value={24}>24 bit</option>
                </select>
              </div>

              <div className="settings-row">
                <label>Channels:</label>
                <select value={conversion.channels} onChange={e => updateConversion(c => ({ ...c, channels: Number(e.target.value) }))}>
                  <option value={1}>Mono</option>
                  <option value={2}>Stereo</option>
                </select>
              </div>

              <div className="settings-row">
                <label>Type:</label>
                <select
                  value={conversion.type}
                  title={conversion.type === 'auto' ? 'Auto: Loop category uses full loop, all other categories use 1-shot.' : ''}
                  onChange={e => updateConversion(c => ({ ...c, type: e.target.value as ConversionSettings['type'] }))}
                >
                  <option value="auto" title="Loop category uses full loop, all other categories use 1-shot.">auto</option>
                  <option value="1-shot">1-shot</option>
                  <option value="full loop">full loop</option>
                </select>
              </div>

              <div className="settings-row">
                <label>Vol:</label>
                <select
                  value={conversion.volume}
                  onChange={e => updateConversion(c => ({ ...c, volume: e.target.value as ConversionSettings['volume'] }))}
                >
                  <option value="+0dB">+0dB</option>
                  <option value="+12dB">+12dB</option>
                </select>
              </div>

              <div className="settings-row">
                <label>Convert:</label>
                <label className="export-checkbox">
                  <input
                    type="checkbox"
                    checked={exportConvert}
                    onChange={e => setExportConvert(e.target.checked)}
                  />
                  <span>Convert before export</span>
                </label>
              </div>

              <div className="settings-row">
                <label>File Name:</label>
                <input
                  className="export-directory-input"
                  value={exportFileName}
                  onChange={e => setExportFileName(e.target.value)}
                  placeholder="e2s"
                />
              </div>

              <div className="settings-row">
                <label>Directory:</label>
                <div className="export-directory-row">
                  <button
                    className={`export-directory-input export-directory-button${exportDirectory ? ' has-value' : ''}`}
                    onClick={handleChooseExportDirectory}
                    title="Choose target folder"
                  >
                    {exportDirectory || 'Choose target folder'}
                  </button>
                </div>
              </div>

              {exportMessage && <div className="export-message">{exportMessage}</div>}

              {isOverRam && (
                <div className="export-message over-limit-message">
                  RAM limit exceeded: {(usedSpace / 1000000).toFixed(2)} MB used / {(maxSpace / 1000000).toFixed(2)} MB max.
                </div>
              )}

              <div className="export-actions-row">
                <button className="close-btn" onClick={() => setShowExportDialog(false)}>Cancel</button>
                <button
                  className={`export-btn${isOverRam ? ' over-limit-export' : ''}`}
                  disabled={exportBusy || isOverRam}
                  onClick={handleRunExport}
                  title={isOverRam ? 'Export blocked: RAM limit exceeded.' : 'Start export'}
                >
                  Start Export
                </button>
              </div>
            </div>
          </div>
        )}
        {showGroupSortDialog && (
          <div className="modal-bg" onClick={() => setShowGroupSortDialog(false)}>
            <div className="modal group-sort-modal" onClick={e => e.stopPropagation()}>
              <h2>Group and sort</h2>
              <p className="group-sort-help">Drag categories to reorder. Slots update live. First category always starts at 500, next at next free slot, etc.</p>
              <div className="group-sort-list">
                {groupOrder.map((cat) => {
                  const previewSlots = getGroupSortPreviewSlots();
                  const [start, end] = previewSlots[cat] || [null, null];
                  const hasSamples = start !== null && end !== null && end > start;
                  return (
                    <div
                      key={cat}
                      className={`group-sort-row${dragCategory === cat ? ' dragging' : ''}`}
                      draggable
                      onDragStart={() => setDragCategory(cat)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={e => {
                        e.preventDefault();
                        if (dragCategory) moveCategory(dragCategory, cat);
                        setDragCategory(null);
                      }}
                      onDragEnd={() => setDragCategory(null)}
                    >
                      <span className="group-cat-name">{cat}</span>
                      <span className="group-sort-status">
                        {hasSamples ? `Slots ${start}-${end - 1}` : 'none present'}
                      </span>
                      <span className="group-drag-handle" aria-hidden="true">::</span>
                    </div>
                  );
                })}
              </div>
              <div className="export-actions-row">
                <button className="close-btn" onClick={() => setShowGroupSortDialog(false)}>Cancel</button>
                <button className="export-btn" onClick={applyGroupAndSort}>Apply</button>
              </div>
            </div>
          </div>
        )}
        {showSamplesFilterModal && (
          <div className="modal-bg" onClick={() => setShowSamplesFilterModal(false)}>
            <div className="modal filter-modal" onClick={e => e.stopPropagation()}>
              <h2>Filter Import List</h2>
              <div className="settings-row filter-row">
                <label>Search:</label>
                <input
                  className="filter-search-input"
                  value={samplesFilterDraft.nameText}
                  onChange={e => setSamplesFilterDraft(prev => ({ ...prev, nameText: e.target.value }))}
                />
              </div>
              <div className="settings-row filter-row filter-row-top">
                <label>Category:</label>
                <div className="filter-category-list" role="group" aria-label="Filter categories">
                  {ELECTRIBE_CATEGORIES.map(cat => (
                    <label key={cat} className="filter-category-item">
                      <input
                        type="checkbox"
                        checked={samplesFilterDraft.categories.includes(cat)}
                        onChange={() => toggleFilterCategory(setSamplesFilterDraft, cat)}
                      />
                      <span>{cat}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="settings-row filter-row">
                <label>Size (KB):</label>
                <div className="filter-range-fields">
                  <input
                    className="filter-range-input"
                    value={samplesFilterDraft.minSizeKB}
                    onChange={e => setSamplesFilterDraft(prev => ({ ...prev, minSizeKB: e.target.value }))}
                    placeholder="min"
                  />
                  <input
                    className="filter-range-input"
                    value={samplesFilterDraft.maxSizeKB}
                    onChange={e => setSamplesFilterDraft(prev => ({ ...prev, maxSizeKB: e.target.value }))}
                    placeholder="max"
                  />
                </div>
              </div>
              <div className="settings-row filter-row">
                <label>Length (sec):</label>
                <div className="filter-range-fields">
                  <input
                    className="filter-range-input"
                    value={samplesFilterDraft.minLengthSec}
                    onChange={e => setSamplesFilterDraft(prev => ({ ...prev, minLengthSec: e.target.value }))}
                    placeholder="min"
                  />
                  <input
                    className="filter-range-input"
                    value={samplesFilterDraft.maxLengthSec}
                    onChange={e => setSamplesFilterDraft(prev => ({ ...prev, maxLengthSec: e.target.value }))}
                    placeholder="max"
                  />
                </div>
              </div>
              <div className="export-actions-row">
                <button className="close-btn" onClick={() => setShowSamplesFilterModal(false)}>Cancel</button>
                <button className="clear-btn" onClick={handleResetSamplesFilter}>Reset</button>
                <button className="export-btn" onClick={handleApplySamplesFilter}>Apply</button>
              </div>
            </div>
          </div>
        )}
        {showChosenFilterModal && (
          <div className="modal-bg" onClick={() => setShowChosenFilterModal(false)}>
            <div className="modal filter-modal" onClick={e => e.stopPropagation()}>
              <h2>Filter Export List</h2>
              <div className="settings-row filter-row">
                <label>Search:</label>
                <input
                  className="filter-search-input"
                  value={chosenFilterDraft.nameText}
                  onChange={e => setChosenFilterDraft(prev => ({ ...prev, nameText: e.target.value }))}
                />
              </div>
              <div className="settings-row filter-row filter-row-top">
                <label>Category:</label>
                <div className="filter-category-list" role="group" aria-label="Filter categories">
                  {ELECTRIBE_CATEGORIES.map(cat => (
                    <label key={cat} className="filter-category-item">
                      <input
                        type="checkbox"
                        checked={chosenFilterDraft.categories.includes(cat)}
                        onChange={() => toggleFilterCategory(setChosenFilterDraft, cat)}
                      />
                      <span>{cat}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="settings-row filter-row">
                <label>Size (KB):</label>
                <div className="filter-range-fields">
                  <input
                    className="filter-range-input"
                    value={chosenFilterDraft.minSizeKB}
                    onChange={e => setChosenFilterDraft(prev => ({ ...prev, minSizeKB: e.target.value }))}
                    placeholder="min"
                  />
                  <input
                    className="filter-range-input"
                    value={chosenFilterDraft.maxSizeKB}
                    onChange={e => setChosenFilterDraft(prev => ({ ...prev, maxSizeKB: e.target.value }))}
                    placeholder="max"
                  />
                </div>
              </div>
              <div className="settings-row filter-row">
                <label>Length (sec):</label>
                <div className="filter-range-fields">
                  <input
                    className="filter-range-input"
                    value={chosenFilterDraft.minLengthSec}
                    onChange={e => setChosenFilterDraft(prev => ({ ...prev, minLengthSec: e.target.value }))}
                    placeholder="min"
                  />
                  <input
                    className="filter-range-input"
                    value={chosenFilterDraft.maxLengthSec}
                    onChange={e => setChosenFilterDraft(prev => ({ ...prev, maxLengthSec: e.target.value }))}
                    placeholder="max"
                  />
                </div>
              </div>
              <div className="export-actions-row">
                <button className="close-btn" onClick={() => setShowChosenFilterModal(false)}>Cancel</button>
                <button className="clear-btn" onClick={handleResetChosenFilter}>Reset</button>
                <button className="export-btn" onClick={handleApplyChosenFilter}>Apply</button>
              </div>
            </div>
          </div>
        )}
        {showHelpModal && (
          <div className="modal-bg" onClick={() => setShowHelpModal(false)}>
            <div className="modal help-modal" onClick={e => e.stopPropagation()}>
              <h2>KorgManager – User Manual</h2>
              <div className="help-modal-body">

                <h3>Overview</h3>
                <p>KorgManager helps you build sample banks for the Korg Electribe 2S. Load your WAV files in the <strong>Import</strong> list, assemble and organize them in the <strong>Export</strong> list, then export a ready-to-use <code>.all</code> file for your device.</p>

                <h3>Import list (left panel)</h3>
                <ul>
                  <li><strong>Import Audio</strong> – Opens a folder picker to load all audio files from a folder (WAV, MP3, FLAC, OGG, AIFF, and more). You can also <strong>drag &amp; drop</strong> files or folders directly onto the list. Non-WAV files are decoded and stored as WAV internally so all export and edit features work normally.</li>
                  <li><strong>Import .all</strong> – Loads an existing Korg Electribe 2S <code>.all</code> sample bank so you can view, edit, and re-export it.</li>
                  <li><strong>Click</strong> a sample to select and preview it. <strong>Double-click</strong> to instantly move it to the Export list.</li>
                  <li><strong>Ctrl+Click</strong> to add/remove individual items from the selection. <strong>Shift+Click</strong> to select a range.</li>
                  <li>Each row shows: slot number · sample rate · bit depth · Mono/Stereo · length · file size.</li>
                  <li><strong>Category</strong> is auto-detected from the filename. Change it at any time using the dropdown on the right of each row. Changing a category while multiple items are selected updates all selected items.</li>
                  <li><strong>Delete</strong> removes selected samples from the Import list. <strong>Clear</strong> removes all.</li>
                </ul>

                <h3>Moving samples to the Export list</h3>
                <ul>
                  <li><strong>Add Sample(s) →</strong> – Adds all currently selected samples.</li>
                  <li><strong>Add all →</strong> – Adds every sample that is currently visible (respects any active filter and sort order).</li>
                  <li>Samples already in the Export list are skipped automatically.</li>
                </ul>

                <h3>Export list (right panel)</h3>
                <ul>
                  <li>Shows the samples that will be written to the export file.</li>
                  <li>Slot numbers are assigned automatically starting from 501 by default.</li>
                  <li>You can edit slot numbers directly. Changing one row reflows that row and following rows while keeping earlier rows unchanged.</li>
                  <li><strong>Delete</strong> removes selected items. <strong>Clear</strong> empties the whole list.</li>
                  <li><strong>Export</strong> opens the Export dialog (see below).</li>
                </ul>

                <h3>Edit Sample dialog</h3>
                <p>Select exactly one sample in the Export list and click <strong>Edit</strong>. Changes are non-destructive — the source file is never modified.</p>
                <ul>
                  <li><strong>Waveform</strong> – Real PCM waveform rendered from decoded audio. Drag the orange <em>start</em> and <em>end</em> handles to set the trim range.</li>
                  <li><strong>Zoom / Scroll</strong> – <strong>−</strong> / <strong>+</strong> buttons zoom out/in (1× – 40×). The viewport scrolls horizontally; the needle auto-scrolls during playback.</li>
                  <li><strong>BPM &amp; Grid</strong> – Set tempo and grid resolution (1/1 – 1/32 beat). Enable <strong>Snap to grid</strong> to lock handles to grid lines.</li>
                  <li><strong>▶ Play once</strong> / <strong>↻ Loop</strong> / <strong>■ Stop</strong> – Transport controls for the trim region.</li>
                  <li><strong>Reset</strong> – If Apply has not been used yet, resets handles to the full duration. If Apply was clicked at least once, fully restores the <em>original source file</em> before any trim was applied.</li>
                  <li><strong>Apply</strong> – Saves the trimmed file and closes. <strong>Cancel</strong> discards all changes.</li>
                </ul>

                <h3>Filter</h3>
                <p>Both lists have a <strong>Filter</strong> button above the sort bar. The filter dialog lets you narrow down what is visible:</p>
                <ul>
                  <li><strong>Search</strong> – Shows only samples whose filename contains the typed text.</li>
                  <li><strong>Categories</strong> – Check one or more categories to show only those. Leave all unchecked to show everything.</li>
                  <li><strong>Size (KB)</strong> – Enter a min and/or max file size.</li>
                  <li><strong>Length (sec)</strong> – Enter a min and/or max duration.</li>
                </ul>
                <p><strong>Apply</strong> activates the filter. <strong>Reset</strong> clears all filter fields immediately. <strong>Cancel</strong> discards unsaved changes. A red notice appears in the list when a filter is active but no items match.</p>

                <h3>Sort bar</h3>
                <p>Click a column name to sort the list. The cycle is: ascending ▲ → descending ▼ → no sort. Sorting is visual only — it does not change slot numbers.</p>
                <ul>
                  <li><strong>Name</strong> – Alphabetical by filename.</li>
                  <li><strong>Category</strong> – Alphabetical by category name.</li>
                  <li><strong>Slot #</strong> – Numerical by slot number.</li>
                  <li><strong>Length</strong> – By audio duration.</li>
                  <li><strong>Size</strong> – By file size.</li>
                </ul>

                <h3>Group and sort (Export list only)</h3>
                <p>Click <strong>Group and sort</strong> above the Export sort bar to open the dialog:</p>
                <ul>
                  <li>Drag categories up or down to set the order in which they are written to the bank.</li>
                  <li>Dragging categories reflows numbering continuously from 501 for preview and apply.</li>
                  <li>The first non-empty category is anchored at slot 501.</li>
                  <li>To create intentional gaps (for example, keep room for more kicks), edit the slot number of the first sample in a later category (for example set Snares to 600).</li>
                  <li>Manual slot edits only affect the edited row and following rows, so categories before the edited row stay unchanged.</li>
                  <li><strong>Apply</strong> locks in the order, sorts samples within each category alphabetically, and assigns permanent slot numbers.</li>
                  <li>The dialog remembers your last custom order.</li>
                </ul>

                <h3>Export dialog</h3>
                <p>Click <strong>Export</strong> in the Export panel header to open the export settings:</p>
                <ul>
                  <li><strong>Mode — e2s.all</strong>: Builds a complete <code>.all</code> sample bank ready for transfer to the Electribe 2S.</li>
                  <li><strong>Mode — Just sort</strong>: Exports the converted audio files into a folder without building a bank (useful for local organization).</li>
                  <li><strong>Format / Sample Rate / Bit Depth / Channels</strong>: Target audio format for conversion. The Electribe 2S default is 48 kHz · 16 bit · Mono · WAV.</li>
                  <li><strong>Type</strong>: <em>auto</em> uses 1-shot for everything except the Loop category (full loop). Override with 1-shot or full loop if needed.</li>
                  <li><strong>Vol</strong>: Apply a +12 dB boost during conversion (recommended for low-volume samples).</li>
                  <li><strong>Convert</strong>: Uncheck to skip audio conversion and export source files as-is.</li>
                  <li><strong>File Name</strong>: Name for the exported file.</li>
                  <li><strong>Directory</strong>: Click to choose the destination folder.</li>
                </ul>

                <h3>RAM bar (footer)</h3>
                <p>The bar at the bottom-right shows the estimated memory used by all Export samples after conversion, measured against the Korg Electribe 2S limit (~24.7 MB). Export is blocked when the limit is exceeded. The headroom figure shows how much space remains.</p>

                <h3>Keyboard shortcuts</h3>
                <ul>
                  <li><strong>↑ / ↓</strong> – Navigate the active list.</li>
                  <li><strong>← / →</strong> – Play (or replay) the currently selected sample.</li>
                  <li><strong>Enter</strong> – Add selected Import samples to the Export list.</li>
                  <li><strong>Delete</strong> – Remove selected samples from the active list.</li>
                  <li><strong>Ctrl+Click</strong> – Toggle individual selection.</li>
                  <li><strong>Shift+Click</strong> – Range selection.</li>
                </ul>

              </div>
              <div className="help-modal-footer">
                <button className="close-btn" onClick={() => setShowHelpModal(false)}>Close</button>
              </div>
            </div>
          </div>
        )}
      </header>
    </div>
  );
}

export default App;
