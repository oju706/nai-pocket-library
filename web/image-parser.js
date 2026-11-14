'use strict';

// NovelAI image metadata, prompt parsing, artist matching, and reference-tag UI.
let webImagePromptSequence = 0;

async function readImagePrompts() {
  const revision = screenRevision;
  const sequence = ++webImagePromptSequence;
  if (!window.Pocket) {
    try {
      const file = await chooseWebPromptImage();
      if (!file || sequence !== webImagePromptSequence || revision !== screenRevision) return;
      const data = await readLocalNovelAiImage(file);
      if (sequence !== webImagePromptSequence || revision !== screenRevision) return;
      showPromptImport(data);
    } catch (error) {
      if (sequence === webImagePromptSequence && revision === screenRevision) {
        toast(error?.message || '读取原图失败。');
      }
    }
    return;
  }
  try {
    const data = await native('readImagePrompts');
    if (!data || revision !== screenRevision) return;
    showPromptImport(data);
  } catch (error) { toast(error.message || '读取原图失败。'); }
}

function chooseWebPromptImage() {
  const input = byId('web-image-prompt');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (file) => {
      if (settled) return;
      settled = true;
      input.removeEventListener('change', changed);
      input.removeEventListener('cancel', cancelled);
      input.value = '';
      resolve(file);
    };
    const changed = () => finish(input.files?.[0] || null);
    const cancelled = () => finish(null);
    input.addEventListener('change', changed);
    input.addEventListener('cancel', cancelled);
    input.value = '';
    try {
      input.click();
    } catch (error) {
      input.removeEventListener('change', changed);
      input.removeEventListener('cancel', cancelled);
      reject(error);
    }
  });
}

const webPromptLimits = Object.freeze({
  fileBytes: 32 * 1024 * 1024,
  pixels: 8_000_000,
  metadataBytes: 2 * 1024 * 1024,
  textFields: 128,
  ifdEntries: 256,
});
const pngSignature = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
const promptParameterWrappers = new Set([
  'comment', 'generation', 'request', 'settings', 'parameters',
  'generationparams', 'generationparameters', 'generationsettings',
]);
const promptDirectParameters = new Set([
  'prompt', 'uc', 'negative_prompt', 'model', 'Source', 'v4_prompt', 'v4_negative_prompt',
  'actual_prompts', 'sampler', 'steps', 'seed', 'width', 'height', 'scale', 'cfg_rescale',
  'noise_schedule', 'strength', 'noise', 'uncond_scale', 'sm', 'sm_dyn', 'qualityToggle',
  'dynamic_thresholding', 'ucPreset', 'n_samples', 'denoise_strength',
]);
let utf8TextEncoder;
let utf8TextDecoder;
let latin1TextDecoder;

function utf8ByteLength(value) {
  return utf8TextEncoder.encode(String(value)).length;
}

function addPromptField(fields, key, value) {
  if (!key || value == null) return;
  if (!(fields instanceof Map)) throw new TypeError('字段集合无效。');
  let unique = key;
  let suffix = 2;
  while (fields.has(unique)) {
    if (String(fields.get(unique)) === String(value)) return;
    unique = `${key}.${suffix++}`;
  }
  if (fields.size >= webPromptLimits.textFields) throw new Error('图片文本字段过多。');
  fields.set(unique, String(value));
}

function promptFieldEntries(fields) {
  if (fields instanceof Map) return [...fields.entries()];
  return Object.entries(fields || {});
}

function promptFieldMap(fields) {
  return fields instanceof Map ? new Map(fields) : new Map(Object.entries(fields || {}));
}

function readPromptU32(data, offset) {
  return data.getUint32(offset, false);
}

function readPromptU16(data, offset, littleEndian = false) {
  return data.getUint16(offset, littleEndian);
}

function readPromptU24LittleEndian(bytes, offset) {
  return bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
}

function promptAscii(bytes, start, end) {
  let value = '';
  for (let index = start; index < end; index++) value += String.fromCharCode(bytes[index]);
  return value;
}

function promptZero(bytes, start, end = bytes.length) {
  for (let index = start; index < end; index++) if (bytes[index] === 0) return index;
  return -1;
}

function promptTextBytes(value) {
  const length = utf8ByteLength(value);
  if (length > webPromptLimits.metadataBytes) throw new Error('图片中的单个文本字段超过 2 MB。');
  return length;
}

function promptStripTrailingNul(value) {
  return String(value).replace(/\0+$/, '');
}

function decodePromptUtf8Loose(bytes, start, end) {
  if (end <= start) return '';
  try {
    return utf8TextDecoder.decode(bytes.subarray(start, end));
  } catch {
    return latin1TextDecoder.decode(bytes.subarray(start, end));
  }
}

function decodePromptUtf16Loose(bytes, start, end, littleEndian) {
  if (end - start >= 2 && bytes[start] === 0xff && bytes[start + 1] === 0xfe) {
    littleEndian = true;
    start += 2;
  } else if (end - start >= 2 && bytes[start] === 0xfe && bytes[start + 1] === 0xff) {
    littleEndian = false;
    start += 2;
  }
  if ((end - start) & 1) end--;
  if (end <= start) return '';
  const encoding = littleEndian ? 'utf-16le' : 'utf-16be';
  return promptStripTrailingNul(new TextDecoder(encoding).decode(bytes.subarray(start, end)));
}

function promptUtf16Endian(bytes, start, end) {
  let evenZeros = 0;
  let oddZeros = 0;
  const sampleEnd = Math.min(end, start + 64);
  for (let offset = start; offset < sampleEnd; offset++) {
    if (bytes[offset] !== 0) continue;
    if ((offset - start) & 1) oddZeros++;
    else evenZeros++;
  }
  if (oddZeros > evenZeros) return true;
  if (evenZeros > oddZeros) return false;
  return null;
}

function decodePromptUserComment(bytes, start, end, tiffLittleEndian) {
  if (end <= start) return '';
  const marker = promptAscii(bytes, start, Math.min(end, start + 8));
  if (marker.startsWith('ASCII')) {
    return promptStripTrailingNul(decodePromptUtf8Loose(bytes, start + 8, end));
  }
  if (marker.startsWith('UNICODE')) {
    const textStart = start + 8;
    const littleEndian = promptUtf16Endian(bytes, textStart, end) ?? tiffLittleEndian;
    return decodePromptUtf16Loose(bytes, textStart, end, littleEndian);
  }
  if (marker.startsWith('JIS')) {
    try {
      return promptStripTrailingNul(new TextDecoder('iso-2022-jp')
        .decode(bytes.subarray(start + 8, end)));
    } catch {
      return '';
    }
  }
  return promptStripTrailingNul(decodePromptUtf8Loose(bytes, start, end));
}

function promptExifFieldName(tag, exifIfd) {
  if (tag === 0x9286) return 'UserComment';
  if (exifIfd) return '';
  switch (tag) {
    case 0x010e: return 'ImageDescription';
    case 0x010f: return 'Make';
    case 0x0110: return 'Model';
    case 0x0131: return 'Software';
    case 0x013b: return 'Artist';
    case 0x8298: return 'Copyright';
    case 0x9c9c: return 'XPComment';
    case 0x9c9e: return 'XPTitle';
    case 0x9c9f: return 'XPSubject';
    default: return '';
  }
}

function promptExifTypeSize(type) {
  if ([1, 2, 6, 7].includes(type)) return 1;
  if ([3, 8].includes(type)) return 2;
  if ([4, 9, 11].includes(type)) return 4;
  return [5, 10, 12].includes(type) ? 8 : 0;
}

function readPromptExifIfd(bytes, data, base, end, relativeOffset, littleEndian, exifIfd) {
  const absolute = base + relativeOffset;
  if (!Number.isSafeInteger(absolute) || absolute < base || absolute + 2 > end) {
    throw new Error('EXIF 目录偏移无效。');
  }
  const count = data.getUint16(absolute, littleEndian);
  if (count > webPromptLimits.ifdEntries) throw new Error('EXIF 目录条目过多，暂时无法读取。');
  if (absolute + 2 + count * 12 > end) throw new Error('EXIF 目录不完整。');
  const fields = new Map();
  let exifOffset = 0;
  let remaining = webPromptLimits.metadataBytes;
  for (let index = 0; index < count; index++) {
    const entry = absolute + 2 + index * 12;
    const tag = data.getUint16(entry, littleEndian);
    const type = data.getUint16(entry + 2, littleEndian);
    const components = data.getUint32(entry + 4, littleEndian);
    if (!exifIfd && tag === 0x8769) {
      exifOffset = data.getUint32(entry + 8, littleEndian);
      continue;
    }
    const name = promptExifFieldName(tag, exifIfd);
    const unit = promptExifTypeSize(type);
    if (!name || !unit || !components) continue;
    const byteLength = components * unit;
    remaining -= byteLength;
    if (remaining < 0) {
      throw new Error('EXIF 文本字段超过 2 MB。');
    }
    const valueOffset = byteLength <= 4
      ? entry + 8
      : base + data.getUint32(entry + 8, littleEndian);
    if (!Number.isSafeInteger(valueOffset) || valueOffset < base || valueOffset + byteLength > end) {
      throw new Error('EXIF 文本字段偏移无效。');
    }
    let value;
    if (tag === 0x9286) {
      value = decodePromptUserComment(bytes, valueOffset, valueOffset + byteLength, littleEndian);
    } else if (tag === 0x9c9c || tag === 0x9c9e || tag === 0x9c9f) {
      value = decodePromptUtf16Loose(bytes, valueOffset, valueOffset + byteLength, true);
    } else {
      value = promptStripTrailingNul(
        decodePromptUtf8Loose(bytes, valueOffset, valueOffset + byteLength),
      );
    }
    if (value) addPromptField(fields, name, value);
  }
  return { fields, exifOffset };
}

function parsePromptExif(bytes, data, base, end) {
  if (base < 0 || base + 8 > end || end > bytes.length) throw new Error('EXIF 数据不完整。');
  let littleEndian;
  if (bytes[base] === 0x49 && bytes[base + 1] === 0x49) littleEndian = true;
  else if (bytes[base] === 0x4d && bytes[base + 1] === 0x4d) littleEndian = false;
  else throw new Error('EXIF 字节序标记无效。');
  if (data.getUint16(base + 2, littleEndian) !== 42) throw new Error('EXIF TIFF 文件头无效。');
  const ifd0 = data.getUint32(base + 4, littleEndian);
  if (!ifd0) return new Map();
  const root = readPromptExifIfd(bytes, data, base, end, ifd0, littleEndian, false);
  const fields = new Map(root.fields);
  if (root.exifOffset) {
    const exif = readPromptExifIfd(bytes, data, base, end, root.exifOffset, littleEndian, true);
    for (const [key, value] of exif.fields) addPromptField(fields, key, value);
  }
  return fields;
}

async function promptDecompress(bytes, format, label) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error(`${label}需要当前 Windows App 支持本地解压。`);
  }
  let reader;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    reader = stream.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > webPromptLimits.metadataBytes) {
        throw new Error(`${label}解压后超过 2 MB。`);
      }
      chunks.push(value);
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  } catch (error) {
    if (String(error?.message || '').includes('超过 2 MB')) throw error;
    throw new Error(`${label}损坏或无法解压。`);
  } finally {
    try { reader?.releaseLock(); } catch { /* The stream is already closed. */ }
  }
}

async function decodePngTextChunk(type, bytes, metadataState) {
  const end = promptZero(bytes, 0);
  if (end < 1 || end > 79) throw new Error('PNG 文本字段名称异常。');
  const key = latin1TextDecoder.decode(bytes.subarray(0, end));
  let start = end + 1;
  let compressed = false;
  let unicode = false;
  if (type === 'zTXt') {
    if (start >= bytes.length || bytes[start++] !== 0) throw new Error('无法识别 PNG 文本的压缩方式。');
    compressed = true;
  } else if (type === 'iTXt') {
    if (start + 2 > bytes.length) throw new Error('PNG 国际文本字段不完整。');
    const flag = bytes[start++];
    const method = bytes[start++];
    if ((flag !== 0 && flag !== 1) || method !== 0) throw new Error('无法识别 PNG 文本的压缩方式。');
    compressed = flag === 1;
    unicode = true;
    const languageEnd = promptZero(bytes, start);
    if (languageEnd < 0) throw new Error('PNG 国际文本字段不完整。');
    const translatedEnd = promptZero(bytes, languageEnd + 1);
    if (translatedEnd < 0) throw new Error('PNG 国际文本字段不完整。');
    start = translatedEnd + 1;
  }
  let text = bytes.subarray(start);
  if (compressed) text = await promptDecompress(text, 'deflate', `PNG ${type} 文本`);
  if (text.byteLength > webPromptLimits.metadataBytes) throw new Error('图片文本解压后超过 2 MB。');
  let value;
  try {
    value = unicode ? utf8TextDecoder.decode(text) : latin1TextDecoder.decode(text);
  } catch {
    throw new Error('PNG 国际文本不是有效的 UTF-8 内容。');
  }
  metadataState.decompressedBytes += text.byteLength;
  if (metadataState.decompressedBytes > webPromptLimits.metadataBytes) {
    throw new Error('图片文本解压后合计超过 2 MB。');
  }
  promptTextBytes(value);
  addPromptField(metadataState.fields, key, value);
}

async function parsePngMetadata(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 33 || pngSignature.some((value, index) => bytes[index] !== value)) {
    throw new Error('文件不是有效的 PNG 原图。');
  }
  const data = new DataView(buffer);
  const fields = new Map();
  const metadataState = { fields, decompressedBytes: 0 };
  let metadataBytes = 0;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let sawHeader = false;
  for (let offset = 8, chunkCount = 0; offset + 12 <= bytes.length; chunkCount++) {
    if (chunkCount >= 10000) throw new Error('PNG 数据块过多。');
    const length = readPromptU32(data, offset);
    if (length > buffer.byteLength - offset - 12) throw new Error('PNG 数据块长度异常，原图可能不完整。');
    const type = promptAscii(bytes, offset + 4, offset + 8);
    const payloadStart = offset + 8;
    if (!sawHeader && type !== 'IHDR') throw new Error('PNG 缺少有效的图片头。');
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) throw new Error('PNG 图片头异常。');
      sawHeader = true;
      width = readPromptU32(data, payloadStart);
      height = readPromptU32(data, payloadStart + 4);
      colorType = bytes[payloadStart + 9];
      if (!width || !height || width * height > webPromptLimits.pixels) {
        throw new Error('原图最多支持 800 万像素。');
      }
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      metadataBytes += length;
      if (metadataBytes > webPromptLimits.metadataBytes) throw new Error('原图中的文本信息超过 2 MB。');
      await decodePngTextChunk(type, bytes.subarray(payloadStart, payloadStart + length), metadataState);
    } else if (type === 'IEND') {
      if (length !== 0) throw new Error('PNG 结束标记异常。');
      return { kind: 'png', width, height, colorType, fields };
    }
    offset = payloadStart + length + 4;
  }
  throw new Error('PNG 文件不完整。');
}

function parseWebpMetadata(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12 || promptAscii(bytes, 0, 4) !== 'RIFF' || promptAscii(bytes, 8, 12) !== 'WEBP') {
    throw new Error('文件不是有效的 WebP 原图。');
  }
  const data = new DataView(buffer);
  const riffEnd = data.getUint32(4, true) + 8;
  if (riffEnd < 12 || riffEnd > bytes.length) throw new Error('WebP 文件不完整。');
  let width = 0;
  let height = 0;
  let hasAlpha = false;
  let hasExif = false;
  let hasXmp = false;
  let exifError = '';
  let metadataBytes = 0;
  let exifBytes = 0;
  const fields = new Map();
  for (let offset = 12, chunkCount = 0; offset + 8 <= riffEnd; chunkCount++) {
    if (chunkCount >= 10000) throw new Error('WebP 数据块过多。');
    const type = promptAscii(bytes, offset, offset + 4);
    const length = data.getUint32(offset + 4, true);
    const start = offset + 8;
    if (length > riffEnd - start) throw new Error('WebP 数据块长度异常。');
    if (type === 'VP8X' && length >= 10) {
      hasAlpha = Boolean(bytes[start] & 0x10);
      width = readPromptU24LittleEndian(bytes, start + 4) + 1;
      height = readPromptU24LittleEndian(bytes, start + 7) + 1;
    } else if (type === 'VP8L' && length >= 5 && bytes[start] === 0x2f) {
      const dimensions = data.getUint32(start + 1, true);
      width = (dimensions & 0x3fff) + 1;
      height = ((dimensions >>> 14) & 0x3fff) + 1;
      hasAlpha = hasAlpha || Boolean(dimensions & 0x10000000);
    } else if (type === 'VP8 ' && length >= 10
      && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
      width ||= readPromptU16(data, start + 6, true) & 0x3fff;
      height ||= readPromptU16(data, start + 8, true) & 0x3fff;
    } else if (type === 'EXIF') {
      hasExif = true;
      exifBytes += length;
      if (exifBytes > webPromptLimits.metadataBytes) throw new Error('WebP EXIF 超过 2 MB。');
      const exifStart = length >= 6 && promptAscii(bytes, start, start + 6) === 'Exif\0\0'
        ? start + 6 : start;
      let exifFields;
      try {
        exifFields = parsePromptExif(bytes, data, exifStart, start + length);
      } catch (error) {
        exifError ||= error.message;
        offset = start + length + (length & 1);
        continue;
      }
      for (const [key, value] of exifFields) {
        metadataBytes += promptTextBytes(value);
        if (metadataBytes > webPromptLimits.metadataBytes) {
          throw new Error('图片中的文本信息超过 2 MB。');
        }
        addPromptField(fields, key, value);
      }
    } else if (type === 'XMP ') {
      hasXmp = true;
    } else if (type === 'ALPH') {
      hasAlpha = true;
    }
    offset = start + length + (length & 1);
  }
  if (!width || !height) throw new Error('WebP 缺少可识别的图片尺寸。');
  if (width * height > webPromptLimits.pixels) throw new Error('原图最多支持 800 万像素。');
  return { kind: 'webp', width, height, hasAlpha, hasExif, hasXmp, exifError, fields };
}

function parseJpegMetadata(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('文件不是有效的 JPEG 原图。');
  }
  const data = new DataView(buffer);
  const fields = new Map();
  const frameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  const xmpSignature = 'http://ns.adobe.com/xap/1.0/\0';
  let width = 0;
  let height = 0;
  let hasExif = false;
  let hasXmp = false;
  let hasComment = false;
  let exifError = '';
  let metadataBytes = 0;
  let reachedImage = false;
  for (let offset = 2, segmentCount = 0; offset < bytes.length; segmentCount++) {
    if (segmentCount >= 10000) throw new Error('JPEG 标记段过多。');
    if (offset + 2 > bytes.length || bytes[offset] !== 0xff) {
      throw new Error('JPEG 标记段结构异常。');
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) throw new Error('JPEG 文件不完整。');
    const marker = bytes[offset++];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    if (marker === 0x00 || marker === 0xd8) throw new Error('JPEG 标记段结构异常。');
    if (offset + 2 > bytes.length) throw new Error('JPEG 标记段不完整。');
    const length = data.getUint16(offset, false);
    if (length < 2 || length > bytes.length - offset) {
      throw new Error('JPEG 标记段长度异常，原图可能不完整。');
    }
    const payloadStart = offset + 2;
    const payloadEnd = offset + length;
    if (marker === 0xda) { reachedImage = true; break; }
    if (marker === 0xe1 && payloadEnd - payloadStart >= 6
      && promptAscii(bytes, payloadStart, payloadStart + 6) === 'Exif\0\0') {
      hasExif = true;
      let exifFields;
      try {
        exifFields = parsePromptExif(bytes, data, payloadStart + 6, payloadEnd);
      } catch (error) {
        exifError ||= error.message;
        offset = payloadEnd;
        continue;
      }
      for (const [key, value] of exifFields) {
        metadataBytes += promptTextBytes(value);
        if (metadataBytes > webPromptLimits.metadataBytes) {
          throw new Error('图片中的文本信息超过 2 MB。');
        }
        addPromptField(fields, key, value);
      }
    } else if (marker === 0xe1 && payloadEnd - payloadStart >= xmpSignature.length
      && promptAscii(bytes, payloadStart, payloadStart + xmpSignature.length) === xmpSignature) {
      hasXmp = true;
    } else if (marker === 0xfe) {
      hasComment = true;
      const value = promptStripTrailingNul(
        decodePromptUtf8Loose(bytes, payloadStart, payloadEnd),
      );
      metadataBytes += promptTextBytes(value);
      if (metadataBytes > webPromptLimits.metadataBytes) {
        throw new Error('图片中的文本信息超过 2 MB。');
      }
      if (value) addPromptField(fields, 'COM', value);
    } else if (frameMarkers.has(marker)) {
      if (length < 8) throw new Error('JPEG 尺寸标记不完整。');
      const frameHeight = data.getUint16(payloadStart + 1, false);
      const frameWidth = data.getUint16(payloadStart + 3, false);
      if (!frameWidth || !frameHeight) throw new Error('JPEG 尺寸标记无效。');
      width ||= frameWidth;
      height ||= frameHeight;
    }
    offset = payloadEnd;
  }
  if (!width || !height) throw new Error('JPEG 缺少可识别的图片尺寸。');
  if (width * height > webPromptLimits.pixels) throw new Error('原图最多支持 800 万像素。');
  if (!reachedImage) throw new Error('JPEG 文件缺少图片数据。');
  return { kind: 'jpeg', width, height, hasExif, hasXmp, hasComment, exifError, fields };
}

function safePromptJsonDepth(value) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of String(value)) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') {
      if (++depth > 64) return false;
    } else if (character === '}' || character === ']') depth--;
  }
  return true;
}

function looksLikePromptJsonObject(value) {
  return typeof value === 'string' && /^\s*\{/.test(value);
}

function promptJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (!looksLikePromptJsonObject(value) || !safePromptJsonDepth(value)) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function compactPromptKey(key) {
  return String(key).toLowerCase().replace(/[_\-\s]/g, '');
}

function normalizePromptParameterName(key) {
  switch (compactPromptKey(key)) {
    case 'sampler': case 'samplername': case 'samplingmethod': return 'sampler';
    case 'steps': case 'nsteps': case 'stepcount': case 'numinferencesteps': case 'samplingsteps': return 'steps';
    case 'seed': case 'randomseed': return 'seed';
    case 'scale': case 'cfgscale': case 'guidancescale': return 'scale';
    case 'cfgrescale': return 'cfg_rescale';
    case 'noiseschedule': return 'noise_schedule';
    case 'negativeprompt': return 'negative_prompt';
    case 'v4prompt': return 'v4_prompt';
    case 'v4negativeprompt': return 'v4_negative_prompt';
    case 'actualprompts': return 'actual_prompts';
    case 'qualitytoggle': return 'qualityToggle';
    case 'ucpreset': return 'ucPreset';
    case 'dynamicthresholding': return 'dynamic_thresholding';
    case 'uncondscale': return 'uncond_scale';
    case 'nsamples': return 'n_samples';
    case 'denoisestrength': return 'denoise_strength';
    case 'smdyn': return 'sm_dyn';
    case 'source': return 'Source';
    case 'prompt': case 'uc': case 'model': case 'width': case 'height': case 'noise':
    case 'strength': case 'sm': return compactPromptKey(key);
    default: return String(key);
  }
}

function setPromptObjectValue(target, key, value) {
  Object.defineProperty(target, key, {
    value, enumerable: true, configurable: true, writable: true,
  });
}

function deepMergePromptObject(target, source) {
  for (const [key, incoming] of Object.entries(source || {})) {
    if (incoming == null) continue;
    const current = Object.hasOwn(target, key) ? target[key] : undefined;
    if (current && typeof current === 'object' && !Array.isArray(current)
      && incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
      deepMergePromptObject(current, incoming);
    } else if (Array.isArray(current) && Array.isArray(incoming) && incoming.length < current.length) {
      continue;
    } else if (typeof current === 'string' && current && typeof incoming === 'string' && !incoming) {
      continue;
    } else {
      setPromptObjectValue(target, key, incoming);
    }
  }
  return target;
}

function flattenPromptParameters(source, depth = 0) {
  const result = {};
  const flattened = new Set();
  let comment = null;
  for (const [key, value] of Object.entries(source || {})) {
    const compact = compactPromptKey(key);
    if (depth >= 32 || !promptParameterWrappers.has(compact)) continue;
    const nested = promptJsonObject(value);
    if (!nested) continue;
    flattened.add(key);
    const fields = flattenPromptParameters(nested, depth + 1);
    if (compact === 'comment') comment = fields;
    else deepMergePromptObject(result, fields);
  }
  for (const [key, value] of Object.entries(source || {})) {
    if (flattened.has(key)) continue;
    const name = normalizePromptParameterName(key);
    if (key !== name && Object.prototype.hasOwnProperty.call(source, name)) continue;
    setPromptObjectValue(result, name, value);
  }
  if (comment) deepMergePromptObject(result, comment);
  return result;
}

function promptObjectValue(object, key) {
  return promptJsonObject(object?.[key]);
}

function promptString(object, key) {
  return typeof object?.[key] === 'string' ? object[key] : '';
}

function promptV4CaptionText(v4) {
  const caption = v4?.caption;
  if (typeof caption === 'string') return caption;
  return promptString(caption, 'base_caption');
}

function promptCharacterCaptions(v4) {
  const caption = v4?.caption;
  const characters = (caption && typeof caption === 'object' ? caption : v4)?.char_captions;
  return Array.isArray(characters) ? characters : [];
}

function promptSourcePriority(key) {
  if (/^Comment$/i.test(key)) return 100;
  if ([...promptParameterWrappers].filter((name) => name !== 'request' && name !== 'comment').includes(compactPromptKey(key))) return 90;
  if (/^(?:UserComment|EXIF:UserComment)$/i.test(key)) return 80;
  if (/^COM(?:\.|$)/i.test(key)) return 70;
  if (/^XPComment(?:\.|$)/i.test(key)) return 60;
  if (/^(?:Description|ImageDescription)$/i.test(key)) return 20;
  return 0;
}

function promptSemanticScore(object) {
  const positive = promptObjectValue(object, 'v4_prompt');
  const negative = promptObjectValue(object, 'v4_negative_prompt');
  let score = 0;
  if (promptV4CaptionText(positive)) score += 1000;
  score += Math.min(1000, promptCharacterCaptions(positive).length * 200);
  if (promptV4CaptionText(negative)) score += 300;
  score += Math.min(500, promptCharacterCaptions(negative).length * 100);
  if (promptString(object, 'prompt')) score += 100;
  if (promptString(object, 'uc') || promptString(object, 'negative_prompt')) score += 50;
  return score;
}

function promptHasSignals(object) {
  return ['prompt', 'uc', 'negative_prompt', 'v4_prompt', 'v4_negative_prompt']
    .some((key) => Object.prototype.hasOwnProperty.call(object, key));
}

function firstPlainPromptField(fields, names) {
  const entries = promptFieldEntries(fields);
  for (const name of names) {
    const found = entries.find(([key, value]) => (
      (key.toLowerCase() === name.toLowerCase()
        || key.toLowerCase().startsWith(`${name.toLowerCase()}.`))
      && !looksLikePromptJsonObject(value)
    ));
    if (found) return String(found[1]);
  }
  return '';
}

function summarizeNovelAiFields(fields, metadataType = 'image metadata', missingReason = '') {
  const fieldEntries = promptFieldEntries(fields);
  const candidates = [];
  for (const [key, value] of fieldEntries) {
    const object = promptJsonObject(value);
    if (!object) continue;
    const flattened = flattenPromptParameters(object);
    if (promptHasSignals(flattened) || promptSourcePriority(key) > 0) {
      candidates.push({
        key, raw: String(value), object: flattened,
        score: promptSourcePriority(key) + promptSemanticScore(flattened),
      });
    }
  }
  candidates.sort((left, right) => left.score - right.score);
  let best = null;
  let parameters = null;
  for (const candidate of candidates) {
    best = candidate;
    if (!parameters) parameters = {};
    deepMergePromptObject(parameters, candidate.object);
  }
  const direct = {};
  for (const [key, value] of fieldEntries) {
    const name = normalizePromptParameterName(key);
    if (!promptDirectParameters.has(name)) continue;
    if ((name === 'v4_prompt' || name === 'v4_negative_prompt' || name === 'actual_prompts')
      && looksLikePromptJsonObject(value)) {
      const object = promptJsonObject(value);
      if (object) setPromptObjectValue(direct, name, object);
    } else if (!looksLikePromptJsonObject(value)) {
      setPromptObjectValue(direct, name, value);
    }
  }
  if (Object.keys(direct).length) {
    parameters ||= {};
    deepMergePromptObject(parameters, direct);
  }
  const positive = promptObjectValue(parameters, 'v4_prompt');
  const negative = promptObjectValue(parameters, 'v4_negative_prompt');
  const prompt = promptString(parameters, 'prompt')
    || promptV4CaptionText(positive)
    || promptString(positive, 'base_caption')
    || firstPlainPromptField(fields, ['Description', 'ImageDescription', 'Prompt']);
  const negativePrompt = promptString(parameters, 'uc')
    || promptString(parameters, 'negative_prompt')
    || promptV4CaptionText(negative)
    || promptString(negative, 'base_caption');
  const actual = promptObjectValue(parameters, 'actual_prompts');
  const actualPositive = promptObjectValue(actual, 'prompt');
  const actualNegative = promptObjectValue(actual, 'negative_prompt');
  const characters = promptCharacterCaptions(positive);
  const negativeCharacters = promptCharacterCaptions(negative);
  const actualPrompt = promptV4CaptionText(actualPositive)
    || promptString(actualPositive, 'base_caption')
    || promptString(actual, 'prompt');
  const actualNegativePrompt = promptV4CaptionText(actualNegative)
    || promptString(actualNegative, 'base_caption')
    || promptString(actual, 'negative_prompt');
  const model = promptString(parameters, 'model')
    || promptString(parameters, 'Source')
    || firstPlainPromptField(fields, ['Source', 'Software', 'Make', 'Model']);
  const found = Boolean(prompt || negativePrompt || actualPrompt || actualNegativePrompt
    || characters.length || negativeCharacters.length);
  const rawComment = best?.raw || firstPlainPromptField(fields,
    ['Comment', 'UserComment', 'EXIF:UserComment', 'COM', 'JPEG:COM', 'XPComment']);
  const metadata = Object.fromEntries(promptFieldEntries(fields).map(([key, value]) => [key, String(value)]));
  const result = {
    found,
    prompt,
    negativePrompt,
    actualPrompt,
    actualNegativePrompt,
    actualCharacters: promptCharacterCaptions(actualPositive),
    actualNegativeCharacters: promptCharacterCaptions(actualNegative),
    model,
    rawComment,
    parameters,
    characters,
    negativeCharacters,
    v4Prompt: positive || null,
    v4NegativePrompt: negative || null,
    metadata,
    metadataType,
  };
  if (found) {
    result.message = '已在本机读取图片中的提示词与参数。';
  } else {
    const reason = missingReason || '未找到可读取的提示词。图片可能没有保存提示词，或已被截图、压缩、转存清除。';
    result.message = reason;
    result.missingReason = reason;
  }
  return result;
}

function promptFieldValueScore(value) {
  const object = promptJsonObject(value);
  return object ? 1000 + promptSemanticScore(object) + String(value).length : String(value || '').length;
}

function mergePromptFields(visible, hidden) {
  const merged = new Map(promptFieldMap(visible));
  for (const [key, incoming] of promptFieldEntries(hidden)) {
    if (!merged.has(key)) {
      merged.set(key, incoming);
      continue;
    }
    const current = merged.get(key);
    const currentObject = promptJsonObject(current);
    const incomingObject = promptJsonObject(incoming);
    if (currentObject && incomingObject) {
      deepMergePromptObject(currentObject, incomingObject);
      merged.set(key, JSON.stringify(currentObject));
    } else if (promptFieldValueScore(incoming) >= promptFieldValueScore(current)) {
      merged.set(key, incoming);
    }
  }
  return merged;
}

async function extractNovelAiAlpha(width, height, alphaAt) {
  const capacity = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('图片尺寸异常。');
  }
  if (capacity < 19 * 8) return null;
  let position = 0;
  const nextByte = () => {
    if (position + 8 > capacity) throw new Error('图片透明通道中的隐藏信息不完整。');
    let value = 0;
    for (let bit = 0; bit < 8; bit++, position++) {
      const x = Math.floor(position / height);
      const y = position % height;
      value = value << 1 | (alphaAt(x, y) & 1);
    }
    return value;
  };
  const magicBytes = new Uint8Array(15);
  for (let index = 0; index < magicBytes.length; index++) magicBytes[index] = nextByte();
  const magic = promptAscii(magicBytes, 0, magicBytes.length);
  const compressed = magic === 'stealth_pngcomp';
  if (!compressed && magic !== 'stealth_pnginfo') return null;
  let bitLength = 0;
  for (let index = 0; index < 4; index++) bitLength = bitLength * 256 + nextByte();
  if (!bitLength || bitLength % 8 || bitLength > webPromptLimits.metadataBytes * 8
    || bitLength > capacity - position) {
    throw new Error('图片隐藏信息长度异常或超过 2 MB。');
  }
  let payload = new Uint8Array(bitLength / 8);
  for (let index = 0; index < payload.length; index++) payload[index] = nextByte();
  if (compressed) payload = await promptDecompress(payload, 'gzip', '图片透明通道隐藏信息');
  if (payload.byteLength > webPromptLimits.metadataBytes) {
    throw new Error('图片隐藏信息解压后超过 2 MB。');
  }
  let root;
  try {
    const raw = utf8TextDecoder.decode(payload);
    if (!safePromptJsonDepth(raw)) throw new Error('depth');
    root = JSON.parse(raw);
  } catch {
    throw new Error('图片透明通道中的隐藏信息不是有效的 UTF-8 JSON。');
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('图片透明通道中的隐藏信息不是 JSON 对象。');
  }
  const fields = new Map();
  let metadataBytes = 0;
  for (const [key, value] of Object.entries(root)) {
    if (value == null) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const bytes = promptTextBytes(text);
    metadataBytes += bytes;
    if (metadataBytes > webPromptLimits.metadataBytes) {
      throw new Error('图片隐藏信息超过 2 MB。');
    }
    addPromptField(fields, key, text);
  }
  return fields;
}

async function loadPromptImageSource(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
        imageOrientation: 'none',
      });
      return { source: bitmap, close: () => bitmap.close?.() };
    } catch {
      // Older WebViews may not support the decoding options.
    }
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('无法解码这张原图。'));
      image.src = url;
    });
    return { source: image, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function promptThumbnail(source, width, height) {
  try {
    const scale = Math.min(1, 512 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return null;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.65, 0.5, 0.35]) {
      const result = canvas.toDataURL('image/jpeg', quality);
      if (smallPromptPreview(result)) return result;
    }
  } catch {
    // The prompt data is still usable when a thumbnail cannot be generated.
  }
  return null;
}

async function inspectPromptImagePixels(file, image) {
  const decoded = await loadPromptImageSource(file);
  let canvas = null;
  let preview = null;
  try {
    const sourceWidth = decoded.source.naturalWidth || decoded.source.width;
    const sourceHeight = decoded.source.naturalHeight || decoded.source.height;
    preview = promptThumbnail(decoded.source, sourceWidth, sourceHeight);
    const canReadAlpha = image.kind === 'png' ? [3, 4, 6].includes(image.colorType) : image.hasAlpha;
    if (!canReadAlpha) return { preview };
    if (sourceWidth !== image.width || sourceHeight !== image.height) {
      throw new Error('图片尺寸与文件头不一致。');
    }
    canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法读取原图的透明通道。');
    context.drawImage(decoded.source, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const fields = await extractNovelAiAlpha(
      image.width,
      image.height,
      (x, y) => pixels[(y * image.width + x) * 4 + 3],
    );
    return { fields, preview };
  } catch (error) {
    return { preview, alphaReadError: error?.message || '无法读取透明通道中的隐藏信息。' };
  } finally {
    canvas?.remove();
    decoded.close();
  }
}

function promptImageMetadataType(image, hasHiddenFields) {
  const labels = [];
  if (image.kind === 'png') labels.push('PNG 文本');
  if (image.hasExif) labels.push('EXIF');
  if (image.hasComment) labels.push('JPEG COM');
  if (hasHiddenFields) labels.push('透明通道隐藏信息');
  return labels.join(' + ') || image.kind.toUpperCase();
}

async function readLocalNovelAiImage(file) {
  utf8TextEncoder ||= new TextEncoder();
  utf8TextDecoder ||= new TextDecoder('utf-8', { fatal: true });
  latin1TextDecoder ||= new TextDecoder('iso-8859-1');
  if (!file || !file.size) throw new Error('未选择有效的图片文件。');
  if (file.size > webPromptLimits.fileBytes) throw new Error('原图超过 32 MB。');
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > webPromptLimits.fileBytes) throw new Error('原图超过 32 MB。');
  const bytes = new Uint8Array(buffer);
  let image;
  if (bytes.length >= 8 && pngSignature.every((value, index) => bytes[index] === value)) {
    image = await parsePngMetadata(buffer);
  } else if (bytes.length >= 12 && promptAscii(bytes, 0, 4) === 'RIFF'
    && promptAscii(bytes, 8, 12) === 'WEBP') {
    image = parseWebpMetadata(buffer);
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    image = parseJpegMetadata(buffer);
  } else {
    throw new Error('目前支持本地读取 NovelAI 保存的 PNG、WebP 或 JPEG 原图。');
  }

  let hiddenFields = new Map();
  let preview = null;
  let pixelError = '';
  try {
    const pixels = await inspectPromptImagePixels(file, image);
    hiddenFields = pixels.fields || new Map();
    preview = pixels.preview;
    pixelError = pixels.alphaReadError || '';
  } catch (error) {
    pixelError = error?.message || '无法显示这张图片的预览。';
  }
  const fields = mergePromptFields(image.fields, hiddenFields);
  const missingReason = image.exifError || pixelError
    || (image.hasXmp ? '这张图含 XMP，本版尚无法从中提取生成参数。' : '');
  const summary = summarizeNovelAiFields(fields, promptImageMetadataType(image, hiddenFields.size), missingReason);
  if (preview) summary.preview = preview;
  return summary;
}

function checkOption(label, checked, change) {
  const wrapper = node('label', 'option-check');
  const input = node('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => change(input.checked));
  wrapper.append(input, node('span', '', label));
  return wrapper;
}

function selectedGeneration(data, selected) {
  const actual = selected.actual;
  const prompt = selected.positive ? (actual && data.actualPrompt || data.prompt || '') : '';
  const negativePrompt = selected.negative ? (actual && data.actualNegativePrompt || data.negativePrompt || '') : '';
  const characters = selected.characters ? (actual && data.actualCharacters?.length ? data.actualCharacters : data.characters || []) : [];
  const negativeCharacters = selected.characters ? (actual && data.actualNegativeCharacters?.length ? data.actualNegativeCharacters : data.negativeCharacters || []) : [];
  const parameters = selected.settings ? { ...data.parameters } : {};
  for (const key of ['prompt', 'uc', 'negative_prompt', 'v4_prompt', 'v4_negative_prompt', 'actual_prompts', 'Comment', 'seed']) delete parameters[key];
  if (selected.seed && data.parameters?.seed !== undefined) parameters.seed = data.parameters.seed;
  const withCaptions = (original, base, rows) => original && selected.characters
    ? { ...original, caption: { base_caption: base, char_captions: rows } } : undefined;
  return {
    prompt, negativePrompt, characters, negativeCharacters, parameters,
    model: selected.settings ? data.model : undefined,
    promptMode: actual ? 'actual' : 'original',
    v4Prompt: withCaptions(data.v4Prompt, prompt, characters),
    v4NegativePrompt: withCaptions(data.v4NegativePrompt, negativePrompt, negativeCharacters),
  };
}

const verifiedModelHashes = new Map([
  ['0ADF9AB7', 'V5 Full'],
  ['657484A5', 'V5 Full'],
  ['70AB5786', 'V5 Full Medium'],
  ['93F4BD30', 'V5 Full Medium'],
  ['DB276663', 'V5 精选'],
  ['4BDE2A90', 'V4.5 Full'],
  ['1229B44F', 'V4.5 Full'],
  ['B9F340FD', 'V4.5 Full'],
  ['F3D95188', 'V4.5 Full'],
  ['C02D4F98', 'V4.5 精选'],
]);

function novelAiModelLabel(value, hash = '') {
  const raw = typeof value === 'string' ? value.trim() : '';
  const api = /^nai-diffusion-(4-5|[345])(?:-(full|curated)(?:-(small|medium))?)?(?:-(inpainting))?$/i.exec(raw);
  const name = /^(?:novelai diffusion\s+(?:anime\s+)?)?v(4\.5|[345])(?=$|[\s(（-])/i.exec(raw);
  const version = api ? `V${api[1].replace('-', '.')}` : name ? `V${name[1]}` : '';
  const variant = api?.[2] || (name && /\b(full|curated)\b|精选/i.exec(raw)?.[0]);
  if (variant) {
    const base = variant.toLowerCase() === 'full' ? 'Full' : '精选';
    const size = api?.[3] || /\b(small|medium)\b/i.exec(raw)?.[0];
    const inpainting = api?.[4] || /\binpainting\b/i.test(raw);
    return `${version} ${base}${size ? ' ' + size[0].toUpperCase() + size.slice(1).toLowerCase() : ''}${inpainting ? ' · 局部重绘' : ''}`;
  }
  const suffix = /(?:^|\s)([a-f0-9]{8})$/i.exec(raw)?.[1];
  const known = verifiedModelHashes.get(String(suffix || hash).toUpperCase());
  if (known && (!version || known.startsWith(`${version} `))) return known;
  return version ? `${version}（型号未核实）` : '未标注';
}

const parameterLabels = {
  model: '模型', sampler: '采样器', steps: '步数', seed: '种子',
  width: '宽度', height: '高度', scale: '提示词引导（CFG）', cfg_rescale: '引导重缩放',
  noise_schedule: '噪声计划', sm: 'SMEA', sm_dyn: 'SMEA DYN',
  qualityToggle: '质量词开关', ucPreset: '负向预设',
  dynamic_thresholding: '动态阈值', strength: '强度', noise: '噪声',
};

function renderCharacterPrompts(container, characters, negatives) {
  if (!Array.isArray(characters)) characters = [];
  if (!Array.isArray(negatives)) negatives = [];
  const caption = (entry) => typeof entry === 'string' ? entry : entry?.char_caption || '';
  for (let i = 0; i < Math.max(characters.length, negatives.length); i++) {
    const title = `角色 ${i + 1}`;
    const positive = characters[i];
    const negative = negatives[i];
    const card = node('section', 'metadata-disclosure');
    const group = node('details', 'character-prompts');
    const fields = { prompt: caption(positive), negativePrompt: caption(negative) };
    if (positive?.centers?.length) fields.centers = positive.centers;
    if (negative?.centers?.length) fields.negativeCenters = negative.centers;
    const body = node('div', 'character-prompts-body');
    group.append(node('summary', '', title));
    addCopyablePrompt(body, title + '正向', fields.prompt);
    addCopyablePrompt(body, title + '负向', fields.negativePrompt);
    const positions = node('dl', 'metadata-facts');
    appendCopyFact(positions, '正向位置', fields.centers);
    appendCopyFact(positions, '负向位置', fields.negativeCenters);
    if (positions.childElementCount) body.append(positions);
    group.append(body);
    card.append(group, button('复制这位角色', 'soft compact metadata-disclosure-copy', () => copy(fields)));
    container.append(card);
  }
}

function addCopyablePrompt(container, label, value) {
  if (!value) return;
  const section = node('div', 'copyable-prompt');
  const control = button('复制' + label, 'soft compact', () => copy(value));
  const heading = node('div', 'prompt-card-heading');
  heading.append(node('h3', '', label), control);
  section.append(heading, node('div', 'prompt', value));
  container.append(section);
}

function promptQuoteEnd(text, start) {
  const quote = text[start].normalize('NFKC');
  for (let index = start + 1; index < text.length; index++) {
    const character = text[index].normalize('NFKC');
    if (character === '\\') {
      index++;
      continue;
    }
    if (character !== quote) continue;
    let nextIndex = index + 1;
    while (nextIndex < text.length && /\s/.test(text[nextIndex])) nextIndex++;
    const next = (text[nextIndex] || '').normalize('NFKC');
    if (!next || ',)]}:'.includes(next)) return index;
    const previous = text[index - 1].normalize('NFKC');
    if (/[\s,([{:]/.test(previous)) return -1;
  }
  return -1;
}

function splitPromptTags(value, recognizeBlocks = false) {
  const parts = [];
  let start = 0;
  let depth = 0;
  const text = String(value ?? '');
  const boundary = /(?:\\?<\/?(?:style|artist)\s*\\?>|&lt;\/?(?:style|artist)\s*&gt;)(?:\\(?=\r?\n))?|(?:\\?\r?\n)(?=[ \t]*(?:[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*::\s*)?artist\s*:)/iy;
  for (let index = 0; index < text.length; index++) {
    const character = text[index].normalize('NFKC');
    if (recognizeBlocks && depth === 0 && /[<\\&\r\n]/.test(character)) {
      boundary.lastIndex = index;
      if (boundary.test(text)) {
        parts.push(text.slice(start, index));
        start = boundary.lastIndex;
        index = start - 1;
        continue;
      }
    }
    if (character === '\\') {
      index++;
      continue;
    }
    if (character === '"' || character === "'") {
      const previous = (text[index - 1] || '').normalize('NFKC');
      if (index === start || /[\s([{:]/.test(previous)) {
        const end = promptQuoteEnd(text, index);
        if (end !== -1) {
          index = end;
          continue;
        }
      }
    }
    if ('([{'.includes(character)) depth++;
    else if (')]}'.includes(character) && depth > 0) depth--;
    if (depth === 0 && character === ',') {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function unwrapPromptTag(value) {
  let result = String(value ?? '').trim();
  let changed = false;
  while (result.length >= 2) {
    const opening = result[0];
    const closing = opening === '(' ? ')' : opening === '[' ? ']' : opening === '{' ? '}' : '';
    if (!closing || result[result.length - 1] !== closing) break;
    let depth = 0;
    let closesAt = -1;
    for (let index = 0; index < result.length; index++) {
      const character = result[index];
      if (character === '\\') {
        index++;
        continue;
      }
      if (character === opening) depth++;
      else if (character === closing) {
        depth--;
        if (depth === 0) {
          closesAt = index;
          break;
        }
      }
    }
    if (closesAt !== result.length - 1) break;
    result = result.slice(1, -1).trim();
    changed = true;
  }
  return { value: result, changed };
}

const promptWeightPrefix = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*::\s*/;

function cleanPromptPart(value) {
  return value.replace(/\\\r?\n/g, '\n').replace(/^\s*(?:&#x20;\s*)+/i, '');
}

function visitPromptTag(value, original, weightedContext, output, weight) {
  let tag = String(value ?? '').normalize('NFKC').trim();
  if (!tag) return;
  tag = tag.replace(/^::\s*/, '').trim();
  tag = tag.replace(/\s*::\s*$/, '').trim();
  if (!tag) return;
  const weightedPrefix = promptWeightPrefix.exec(tag);
  if (weightedPrefix) {
    let body = tag.slice(weightedPrefix[0].length).trim();
    if (body.endsWith('::')) body = body.slice(0, -2).trim();
    for (const part of splitPromptTags(body)) visitPromptTag(part, original, 'numeric', output, null);
    return;
  }
  const unwrapped = unwrapPromptTag(tag);
  if (unwrapped.changed) {
    const parts = splitPromptTags(unwrapped.value);
    for (const part of parts) visitPromptTag(part, original, weightedContext || 'wrapped', output, null);
    return;
  }
  if (weightedContext) {
    tag = tag.replace(/\s*:\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*$/, '').trim();
  }
  if (!tag) return;
  const explicit = /^artist\s*:\s*([\s\S]*)$/i.exec(tag);
  let name = (explicit ? explicit[1] : tag).trim();
  const repairColon = Boolean(explicit && weightedContext === 'numeric' && /[^:\\]:$/.test(name));
  if ((name[0] === '"' || name[0] === "'") && promptQuoteEnd(name, 0) === name.length - 1) {
    name = name.slice(1, -1).trim();
  }
  if (!name) return;
  output.push({
    explicit: Boolean(explicit),
    name: unescapeTagPunctuation(name),
    key: artistTagKey(name),
    original: original || tag,
    token: tag,
    repairColon,
    weight,
  });
}

function extractPromptTags(value, { trackWeights = false } = {}) {
  const output = [];
  const groups = [];
  for (const part of splitPromptTags(value, true)) {
    const original = part.trim();
    const parsed = cleanPromptPart(part);
    if (!trackWeights) {
      visitPromptTag(parsed, original, null, output);
      continue;
    }
    let tag = parsed.normalize('NFKC').trim();
    let prefix;
    while ((prefix = promptWeightPrefix.exec(tag))) {
      const weight = Number(prefix[1]);
      const excessDigits = prefix[1].split('.')[1]?.slice(2);
      groups.push(isArtistChainWeight(weight) && !/[1-9]/.test(excessDigits || '') ? weight : null);
      tag = tag.slice(prefix[0].length).trim();
    }
    const closesGroup = tag.endsWith('::') && !tag.endsWith('\\::');
    if (closesGroup) tag = tag.slice(0, -2).trim();
    const complex = /::|[{}\[\]|]/.test(tag) || /:\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*$/.test(tag);
    const malformed = tag.includes('::') || /^artist\s*:\s*.+[^:\\]:$/i.test(tag);
    if (malformed && groups.length) groups[0] = null;
    let weight = groups.length ? groups[0] : 1;
    if (complex || malformed || groups.length > 1 || (closesGroup && !groups.length)) weight = null;
    visitPromptTag(tag, original, groups.length ? 'numeric' : null, output, weight);
    if (closesGroup) groups.pop();
  }
  return output;
}

function artistCardTag(card) {
  if (isDanbooruTagFavorite(card)) return String(card.prompt || '').trim().replace(/^artist\s*:\s*/i, '');
  const title = String(card?.title ?? '').normalize('NFKC').trim();
  if (title) return title.replace(/^artist\s*:\s*/i, '').trim();
  return String(card?.prompt ?? '').normalize('NFKC').trim().replace(/^artist\s*:\s*/i, '').trim();
}

function promptArtistCatalog(koreanResults = [], { loading = false, importedResults = [] } = {}) {
  const records = [];
  const identities = new Set();
  const addCards = (cards, kind) => {
    for (const card of Array.isArray(cards) ? cards : []) {
      if (card?.section !== 'artist') continue;
      const name = artistCardTag(card);
      const key = artistTagKey(name);
      if (!key) continue;
      const recordId = [kind, card.id, card.title, card.source, card.model].join('\u0000');
      if (identities.has(recordId)) continue;
      identities.add(recordId);
      const keys = [key];
      let identity = key;
      const explicitName = /^artist\s*:\s*([\s\S]+)$/i.exec(card.prompt || '')?.[1];
      if (explicitName && explicitName !== name) {
        const tags = extractPromptTags(card.prompt);
        const tag = tags[0];
        if (tags.length === 1 && tag.explicit && tag.key && tag.key !== key) {
          keys.push(tag.key);
          identity = tag.key;
        }
      }
      records.push({ card, keys, kind, identity });
    }
  };
  if (loading) addCards(state.korean, 'korean');
  for (const result of koreanResults) {
    if (result.status === 'fulfilled') addCards(result.value, 'korean');
  }
  addCards(state.packRows, 'imported');
  for (const result of importedResults) {
    if (result.status === 'fulfilled') addCards(result.value, 'imported');
  }
  addCards(state.online, 'nax');
  addCards(state.personal, 'personal');
  const index = new Map();
  for (const record of records) {
    for (const key of record.keys) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(record);
    }
  }
  const failures = koreanResults
    .map((result, index) => result.status === 'rejected' ? koreanPacks[index]?.[1] : '')
    .filter(Boolean);
  return {
    index,
    records,
    loading,
    koreanReady: koreanResults.filter((result) => result.status === 'fulfilled').length,
    koreanFailures: failures,
    naxCount: records.filter((record) => record.kind === 'nax').length,
    importedCount: records.filter((record) => record.kind === 'imported').length,
    importedFailures: importedResults.filter((result) => result.status === 'rejected').length,
  };
}

function characterPromptCaption(entry) {
  return typeof entry === 'string' ? entry : entry?.char_caption || '';
}

function promptArtistSources(generation) {
  const positive = [];
  const negative = [];
  if (generation.prompt) positive.push({ label: '主提示词 · 正向', prompt: generation.prompt });
  if (generation.negativePrompt) negative.push({ label: '主提示词 · 负向', prompt: generation.negativePrompt });
  const characters = Array.isArray(generation.characters) ? generation.characters : [];
  const negativeCharacters = Array.isArray(generation.negativeCharacters) ? generation.negativeCharacters : [];
  for (let index = 0; index < Math.max(characters.length, negativeCharacters.length); index++) {
    const prompt = characterPromptCaption(characters[index]);
    const negativePrompt = characterPromptCaption(negativeCharacters[index]);
    if (prompt) positive.push({ label: `角色 ${index + 1} · 正向`, prompt });
    if (negativePrompt) negative.push({ label: `角色 ${index + 1} · 负向`, prompt: negativePrompt });
  }
  return { positive, negative };
}

function resolvePromptArtist(tag, catalog) {
  let name = tag.name;
  let key = tag.key;
  let candidates = catalog.index.get(key) || [];
  if (tag.repairColon && !candidates.length) {
    const shortName = name.slice(0, -1).trimEnd();
    const shortKey = artistTagKey(shortName);
    if (shortKey && catalog.index.has(shortKey)) {
      name = shortName;
      key = shortKey;
      candidates = catalog.index.get(key);
    }
  }
  if (!tag.explicit && !candidates.length) {
    const alias = /^artist_(.+)$/i.exec(name)?.[1];
    const aliasKey = alias ? artistTagKey(alias) : '';
    if (aliasKey && catalog.index.has(aliasKey)) {
      key = aliasKey;
      candidates = catalog.index.get(key);
    }
  }
  if (!tag.explicit && !candidates.length) return null;
  const ambiguous = new Set(candidates.map(({ identity }) => identity)).size > 1;
  return { key, name, candidates: ambiguous ? [] : candidates, ambiguous };
}

function collectPromptArtists(generation, catalog, negative = false) {
  const output = new Map();
  const sources = promptArtistSources(generation)[negative ? 'negative' : 'positive'];
  for (const source of sources) {
    for (const tag of extractPromptTags(source.prompt)) {
      const resolved = resolvePromptArtist(tag, catalog);
      if (!resolved) continue;
      const { key } = resolved;
      if (!output.has(key)) {
        output.set(key, {
          ...resolved, explicit: tag.explicit, sources: new Set(), originals: new Set(),
        });
      }
      const item = output.get(key);
      item.explicit ||= tag.explicit;
      item.sources.add(source.label);
      item.originals.add(tag.original);
    }
  }
  return output;
}

function weightedPromptArtists(prompt, catalog, targetModel, { allowExplicit = false } = {}) {
  const matches = new Map();
  for (const tag of extractPromptTags(prompt, { trackWeights: true })) {
    const resolved = resolvePromptArtist(tag, catalog);
    if (!resolved) continue;
    const record = preferredArtistRecord(resolved.candidates, targetModel);
    const key = record?.identity || resolved.key;
    const card = record?.card || (allowExplicit && tag.explicit && !resolved.ambiguous
      ? { title: resolved.name, prompt: 'artist:' + artistChainEscapeCommas(resolved.name) } : null);
    const existing = matches.get(key);
    const weight = existing && existing.weight !== tag.weight ? null : tag.weight;
    matches.set(key, { card, weight });
  }
  const weights = new Map();
  let skipped = 0;
  for (const { card, weight } of matches.values()) {
    if (card && isArtistChainWeight(weight)) weights.set(card, weight);
    else skipped++;
  }
  return { weights, skipped };
}

function artistModelSeries(value) {
  const text = String(value ?? '');
  if (/V5/i.test(text)) return 'V5';
  if (/V4\.5/i.test(text)) return 'V4.5';
  return '';
}

function preferredArtistRecord(candidates, targetModel) {
  const kindRank = { imported: 4, korean: 3, nax: 2, personal: 1 };
  return [...candidates].map((record, index) => {
    const series = artistModelSeries(record.card.model);
    return {
      record, index,
      score: (targetModel && series === targetModel ? 1000 : 0)
        + (record.card.photos?.length ? 100 : 0)
        + (kindRank[record.kind] || 0),
    };
  }).sort((left, right) => right.score - left.score || left.index - right.index)[0]?.record;
}

function promptArtistCatalogNote(catalog) {
  const parts = [];
  if (catalog.loading) parts.push('韩国目录读取中');
  else {
    const failure = catalog.koreanFailures.length ? `（${catalog.koreanFailures.join('、')}失败）` : '';
    parts.push(`韩国 ${catalog.koreanReady}/${koreanPacks.length}${failure}`);
  }
  if (Array.isArray(state.online)) parts.push(`NAX ${catalog.naxCount} 位`);
  else if (state.onlineTask) parts.push('NAX 读取中');
  else parts.push('NAX 未加载');
  if (Array.isArray(state.packRows)) {
    const failures = catalog.importedFailures ? `（${catalog.importedFailures} 个目录未能读取）` : '';
    parts.push(`导入 ${catalog.importedCount} 位${failures}`);
  }
  else if (state.importing) parts.push('导入目录读取中');
  else parts.push('导入目录未加载');
  return parts.join(' · ');
}

let promptArtistPanelSequence = 0;

function promptArtistRow(item, catalog, targetModel, openSample, polarity, sampleState) {
  const row = node('div', 'prompt-artist-row');
  const header = node('div', 'pack-source');
  const info = node('div');
  info.append(node('strong', '', item.name));
  tagDictionaryAppend(info, item.name, () => row.isConnected);
  if (item.candidates.length) {
    const librarySources = [...new Set(item.candidates.map((record) =>
      record.card.source || (record.kind === 'nax' ? 'NAX' : record.kind === 'imported' ? '已导入' : '韩国 V5')))];
    info.append(node('small', '', `库内同名 · ${librarySources.join('；')}`));
  } else if (item.ambiguous) {
    info.append(node('small', '', '同名对应多个完整标签，可在画风串里搜索确认。'));
  } else {
    info.append(node('small', '', '显式 artist: · 已保留，当前目录未精确命中'));
  }
  info.append(node('small', '', `来源：${[...item.sources].join('、')} · 原值：${[...item.originals].join(' / ')}`));
  const controls = node('div', 'copy-fact');
  controls.append(button('复制原标签', 'text-button', () => copy([...item.originals].join('\n'))));
  const preferred = preferredArtistRecord(item.candidates, targetModel);
  if (preferred) {
    const sampleModel = preferred.card.model || '未标注';
    const targetSeries = artistModelSeries(targetModel);
    const sampleSeries = artistModelSeries(sampleModel);
    info.append(node('small', '', `样图模型：${sampleModel}${targetSeries && sampleSeries && targetSeries !== sampleSeries ? `（当前 ${targetSeries}）` : ''}`));
    const photos = Array.isArray(preferred.card.photos) ? preferred.card.photos : [];
    if (photos.length) {
      const stateKey = `${polarity}:${item.key}`;
      const state = sampleState.get(stateKey) || { expanded: false, index: 0 };
      if (!Number.isSafeInteger(state.index) || state.index < 0 || state.index >= photos.length) state.index = 0;
      sampleState.set(stateKey, state);
      const panel = node('div', 'artist-sample-panel');
      panel.id = `artist-sample-${++promptArtistPanelSequence}`;
      panel.hidden = true;
      let loadRevision = 0;
      let toggle;

      function loadSample() {
        const photo = photos[state.index];
        const revision = ++loadRevision;
        panel.hidden = false;
        if (!photo?.url) {
          panel.replaceChildren(node('p', 'resource-note', '样图加载失败：当前条目没有可用的图片地址。'));
          return;
        }
        const frame = node('div', 'photo');
        const status = node('div', 'artist-sample-status', '正在读取样图…');
        status.setAttribute('role', 'status');
        const image = node('img');
        image.alt = `${item.name} · ${photo.label || `样图 ${state.index + 1}`}`;
        image.hidden = true;
        image.onload = () => {
          if (revision !== loadRevision || panel.hidden) return;
          image.hidden = false;
          status.remove();
        };
        image.onerror = () => {
          if (revision !== loadRevision || panel.hidden) return;
          image.hidden = true;
          status.replaceChildren(node('span', '', '样图加载失败。'),
            button('重试', 'text-button', loadSample));
        };
        const position = node('span', '', `${state.index + 1} / ${photos.length} · ${photo.label || '样图'}`);
        const previous = button('上一张', 'text-button', () => {
          state.index = (state.index + photos.length - 1) % photos.length;
          loadSample();
        });
        const next = button('下一张', 'text-button', () => {
          state.index = (state.index + 1) % photos.length;
          loadSample();
        });
        previous.disabled = next.disabled = photos.length < 2;
        const nav = node('div', 'photo-nav artist-sample-nav');
        nav.append(previous, position, next);
        frame.append(status, image);
        panel.replaceChildren(frame, nav);
        image.src = photo.url;
      }

      toggle = button(state.expanded ? '收起样图' : '看样图', 'soft compact', () => {
        state.expanded = !state.expanded;
        panel.hidden = !state.expanded;
        toggle.textContent = state.expanded ? '收起样图' : '看样图';
        toggle.setAttribute('aria-expanded', String(state.expanded));
        if (state.expanded) loadSample();
        else loadRevision++;
      });
      toggle.setAttribute('aria-expanded', String(state.expanded));
      toggle.setAttribute('aria-controls', panel.id);
      controls.append(toggle);
      if (state.expanded) loadSample();
      header.append(info, controls);
      row.append(header, panel);
      return row;
    }
    controls.append(button('看详情', 'soft compact', () => openSample(preferred.card)));
  }
  header.append(info, controls);
  row.append(header);
  return row;
}

function renderPromptArtistUsage(generation, catalog, openSample, sampleState, openArtistChain, openWeightedChain) {
  const section = node('section', 'tool-section');
  const title = node('h2', '', '画风库画师');
  const used = collectPromptArtists(generation, catalog);
  const negative = collectPromptArtists(generation, catalog, true);
  const targetModel = artistModelSeries(novelAiModelLabel(
    generation.parameters?.model || generation.parameters?.model_name || generation.model,
    generation.parameters?.model_hash));
  const matchedPositive = [...used.values()].filter((item) => item.candidates.length);
  title.append(node('span', 'muted', ` · 正向命中 ${matchedPositive.length} 位`));
  section.append(title,
    node('p', 'resource-note', `${promptArtistCatalogNote(catalog)}。仅按完整标签精确识别；无前缀必须与库内规范化名称完全一致，不扫描自然语言。`));
  const controls = node('div', 'tool-actions');
  if (matchedPositive.length && openArtistChain) {
    controls.append(button(`把识别到的 ${matchedPositive.length} 位画师加入画风串`, 'soft compact', () => {
      openArtistChain(matchedPositive, targetModel);
    }));
  }
  if (generation.prompt && openWeightedChain) {
    const { weights, skipped } = weightedPromptArtists(generation.prompt, catalog, targetModel);
    if (weights.size || skipped) {
      const destination = targetModel || currentArtistChain().model;
      const addWeighted = button('按原权重加入画风串', 'primary compact',
        () => openWeightedChain(weights, skipped, destination));
      addWeighted.disabled = !weights.size;
      const hint = `主正向提示词 · ${destination} · 可加入 ${weights.size} 位`;
      controls.append(addWeighted, node('span', 'muted',
        skipped ? `${hint} · ${skipped} 位标签或倍率无法确认` : hint));
    }
  }
  if (controls.childElementCount) section.append(controls);
  if (!used.size) {
    section.append(node('p', 'detail-note', catalog.loading
      ? '显式 artist 已可识别；无前缀画师会在目录读取完成后按同名匹配。'
      : '没有识别到正向使用的库内画师。'));
  } else {
    for (const item of used.values()) {
      section.append(promptArtistRow(item, catalog, targetModel, openSample, 'positive', sampleState));
    }
  }
  if (negative.size) {
    const details = node('details', 'metadata-details');
    details.append(node('summary', '', `负向中出现 · ${negative.size} 位（不视为使用）`));
    for (const item of negative.values()) {
      details.append(promptArtistRow(item, catalog, targetModel, openSample, 'negative', sampleState));
    }
    section.append(details);
  }
  return section;
}

const promptCoverBytes = 192 * 1024;

function smallPromptPreview(value) {
  return typeof value === 'string' && value.length <= promptCoverBytes * 4 / 3 + 'data:image/jpeg;base64,'.length
    && /^data:image\/(?:jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
}

function promptTagLibraryMatches(generation, artistCatalog) {
  const { positive, negative } = promptArtistSources(generation);
  const tags = new Map();
  for (const { label, prompt } of [...positive, ...negative]) {
    for (const tag of extractPromptTags(prompt)) {
      if (!tag.key) continue;
      const id = tag.explicit ? 'artist:' + tag.key : tag.key;
      if (!tags.has(id)) tags.set(id, { ...tag, sources: new Set(), cards: new Map() });
      tags.get(id).sources.add(label);
    }
  }
  if (!tags.size) return [];

  function register(value, card, kind) {
    const tag = tags.get(artistTagKey(value));
    if (tag && !tag.cards.has(card.id)) tag.cards.set(card.id, { card, kind });
  }
  for (const card of [...PocketSources.knowledge, ...state.personal, ...(state.online || [])]) {
    if (!['character', 'knowledge'].includes(card.section)) continue;
    const kind = card.section === 'character' ? 'character' : 'general';
    register(card.title, card, kind);
    if (card.prompt) {
      if (!/[,:{}\[\]]/.test(card.prompt)) register(card.prompt, card, kind);
      else {
        const terms = extractPromptTags(card.prompt);
        if (terms.length === 1) register(terms[0].name, card, kind);
      }
    }
    if (card.work && card.section === 'character') register(card.work, card, 'copyright');
  }
  for (const tag of tags.values()) {
    const artist = resolvePromptArtist(tag, artistCatalog);
    for (const { card } of artist?.candidates || []) {
      if (!tag.cards.has(card.id)) tag.cards.set(card.id, { card, kind: 'artist' });
    }
  }
  return [...tags.values()];
}

function renderPromptTagLibrary(list, generation, artistCatalog, openBack, visibleCount = 0) {
  const tags = promptTagLibraryMatches(generation, artistCatalog);
  const matched = tags.filter((tag) => tag.cards.size).length;
  const summary = node('p', 'resource-note',
    `当前词库命中 ${matched} / ${tags.length} 个词。点「查看词库」读条目说明。`);
  const rows = node('div', 'reference-tag-list');
  const pageSize = 24;
  let shown = 0;
  const more = button('显示更多 TAG', 'soft compact', () => appendPage());
  const revision = screenRevision;

  function openMatches(tag) {
    const scroll = body.scrollTop;
    const returnToPrompt = () => openBack(scroll);
    const entries = [...tag.cards.values()];
    if (entries.length === 1) {
      showCard(entries[0].card, 0, returnToPrompt);
      return;
    }
    function showList() {
      openScreen('匹配的词库条目', returnToPrompt);
      body.append(node('h2', '', tag.token));
      const results = node('div', 'reference-tag-list');
      entries.forEach(({ card, kind }) => {
        const line = node('div', 'pack-source reference-tag-row');
        line.append(node('strong', 'reference-tag-name', card.title),
          node('small', 'muted', [tagGalleryKindInfo(kind).label, card.model, card.source].filter(Boolean).join(' · ')),
          button('查看条目', 'soft compact', () => showCard(card, 0, showList)));
        results.append(line);
      });
      body.append(results);
    }
    showList();
  }

  function appendPage(count = pageSize) {
    for (const tag of tags.slice(shown, shown + count)) {
      const row = node('div', 'reference-tag-row');
      const header = node('div', 'tag-gallery-tag-name');
      header.append(node('strong', 'reference-tag-name', tag.token));
      const kinds = [...new Set([...tag.cards.values()].map(({ kind }) => kind))];
      for (const kind of kinds) header.append(node('span', 'tag-gallery-tag-category', tagGalleryKindInfo(kind).label));
      tagDictionaryAppend(header, tag.name, () => revision === screenRevision);
      const controls = node('div', 'reference-tag-actions');
      controls.append(button('复制 TAG', 'soft compact', () => copy(tag.token)));
      if (tag.cards.size) controls.append(button('查看词库', 'soft compact', () => openMatches(tag)));
      const wikiTag = PocketSources.tagGalleryTag(tag.name);
      if (/^[a-z0-9][a-z0-9_()'.-]*$/i.test(wikiTag)) controls.append(button('D 站 Wiki', 'text-button', () =>
        openTagGalleryWebsite('https://danbooru.donmai.us/wiki_pages/' + encodeURIComponent(wikiTag))));
      row.append(header, node('small', 'muted', [...tag.sources].join('、')), controls);
      rows.append(row);
    }
    shown = Math.min(tags.length, shown + count);
    list.dataset.visibleTags = String(shown);
    more.hidden = shown >= tags.length;
  }

  list.replaceChildren(summary, rows, more);
  appendPage(Math.max(pageSize, visibleCount));
}

async function promptFavoriteCover(preview, galleryItem, sampleImage) {
  if (smallPromptPreview(preview)) return preview;
  try {
    if (galleryItem) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(galleryImageUrl(galleryItem, true), { signal: controller.signal });
        if (!response.ok) return null;
        const blob = await response.blob();
        if (blob.size > promptCoverBytes || !['image/jpeg', 'image/webp'].includes(blob.type)) return null;
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(smallPromptPreview(reader.result) ? reader.result : null);
          reader.onerror = reader.onabort = () => resolve(null);
          try { reader.readAsDataURL(blob); } catch { resolve(null); }
        });
      } finally { clearTimeout(timeout); }
    }
    if (!sampleImage?.naturalWidth || !sampleImage.naturalHeight) return null;
    const scale = Math.min(1, 384 / Math.max(sampleImage.naturalWidth, sampleImage.naturalHeight));
    const canvas = node('canvas');
    canvas.width = Math.max(1, Math.round(sampleImage.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(sampleImage.naturalHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return null;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(sampleImage, 0, 0, canvas.width, canvas.height);
    const cover = canvas.toDataURL('image/jpeg', .8);
    return smallPromptPreview(cover) ? cover : null;
  } catch {
    return null;
  }
}

function showPromptImport(data, {
  back = null, galleryItem = null, resourcePhoto = null, promptState = null, promptScroll = 0,
  referenceTags = [], referenceSource = '', referenceSite = 'danbooru', referenceSelected = [],
} = {}) {
  const sample = Boolean(resourcePhoto);
  const references = (Array.isArray(referenceTags) ? referenceTags : [])
    .map((tag) => typeof tag === 'string' ? { name: tag, kind: '' } : tag)
    .filter((tag) => tag && String(tag.name || '').trim())
    .map((tag) => ({ name: String(tag.name).trim(), kind: String(tag.kind || '').trim() }));
  const selectedReferences = new Set((Array.isArray(referenceSelected) ? referenceSelected : [])
    .map((value) => String(value).trim()).filter(Boolean));
  openScreen(sample ? '样图提示词与参数'
    : references.length && !data.found ? '图站参考标签' : '原图提示词与参数', back);
  const revision = screenRevision;
  const restored = promptState && typeof promptState === 'object' ? promptState : null;
  const restoredScroll = Number.isFinite(promptScroll) ? Math.max(0, promptScroll) : 0;
  const libraryButton = button('存小预览到图库', 'soft compact', async () => {
    libraryButton.disabled = true;
    try {
      const saved = await native('saveLastOriginal');
      if (revision !== screenRevision) return;
      if (!saved?.id) throw new Error('无法保存原图。');
      libraryButton.replaceWith(button('打开原图图库', 'soft compact', showGallery));
      toast(saved.promptCached ? '图库已保存图片预览和生成信息' : '图片预览已在图库');
    } catch (error) {
      if (revision !== screenRevision) return;
      libraryButton.disabled = false;
      toast(error.message);
    }
  });
  let fallbackPreview = null;
  if (!resourcePhoto?.preview && smallPromptPreview(data.preview)) {
    fallbackPreview = node('img', 'original-preview');
    fallbackPreview.src = data.preview;
    fallbackPreview.alt = '所选原图预览';
  } else if (!resourcePhoto?.preview && galleryItem) {
    fallbackPreview = node('img', 'original-preview');
    fallbackPreview.src = galleryImageUrl(galleryItem, true);
    fallbackPreview.alt = '图库小预览';
    fallbackPreview.addEventListener('error', () => {
      fallbackPreview.remove();
      layout.classList.remove('has-preview');
      if (revision === screenRevision) screen.classList.remove('detail-wide');
    });
  }
  const hasPreview = Boolean(resourcePhoto?.preview || fallbackPreview);
  if (hasPreview) screen.classList.add('detail-wide');
  const layout = node('div', `prompt-import-layout${hasPreview ? ' has-preview' : ''}`);
  const media = node('div', 'prompt-import-media');
  const info = node('div', 'prompt-import-info');
  layout.append(media, info);
  body.append(layout);
  if (window.Pocket && !galleryItem && !sample && !references.length) info.append(libraryButton);
  if (sample) {
    const source = resourcePhoto;
    if (source.preview) {
      source.preview.className = 'original-preview';
      media.append(source.preview);
    }
    const facts = ['样图', source.title, source.label, source.source].filter(Boolean);
    info.append(node('p', 'resource-note', facts.join(' · ')));
  }
  if (galleryItem) {
    info.append(node('p', 'resource-note', data.promptCached
      ? '生成信息已在本机保存。'
      : '此次结果未能存入图库。可使用「收藏所选」长期保留需要的内容。'));
  }
  if (fallbackPreview) media.append(fallbackPreview);
  const hasGeneration = Boolean(data.found || data.actualPrompt || data.actualNegativePrompt
    || data.actualCharacters?.length || data.actualNegativeCharacters?.length);
  const availablePrompt = hasGeneration || references.length;
  if (!availablePrompt) info.append(node('p', 'detail-note', data.message || '未读到提示词。截图和转存可能清除生成信息。'));
  info.append(node('p', 'resource-note', references.length
    ? `${data.metadataType || '图站参考标签'} · 参考标签不是原图的生成提示词，也不会自动覆盖画风串草稿。`
    : `${data.metadataType || '图片元数据'} · 可逐项复制，勾选控制「复制所选」。`));
  const selection = node('div', 'prompt-selection');
  const content = node('div');
  const artistMatches = node('div');
  const tagLookup = node('details', 'metadata-details prompt-tag-library');
  const tagLookupResults = node('div');
  tagLookup.append(node('summary', '', '检索提示词里的 TAG'), tagLookupResults);
  if (restored?.shownTags) tagLookupResults.dataset.visibleTags = String(restored.shownTags);
  content.append(artistMatches);
  const selected = {};
  const artistSampleState = new Map();
  let preparingFavorite = false;
  const hasActual = Boolean(data.actualPrompt || data.actualNegativePrompt
    || data.actualCharacters?.length || data.actualNegativeCharacters?.length);
  selected.actual = hasActual && Boolean(restored?.actual);
  const groups = [
    ['positive', '正向提示词', Boolean(data.prompt || data.actualPrompt)],
    ['negative', '负向提示词', Boolean(data.negativePrompt || data.actualNegativePrompt)],
    ['characters', '角色提示词和位置', Boolean(data.characters?.length || data.negativeCharacters?.length || data.actualCharacters?.length || data.actualNegativeCharacters?.length)],
    ['settings', '模型与生成设置', Boolean(data.parameters || data.model)],
    ['seed', '种子', data.parameters?.seed !== undefined],
  ];
  for (const [key, label, available] of groups) {
    const checked = available && (restored ? Boolean(restored[key]) : true);
    selected[key] = checked;
    if (available) selection.append(checkOption(label, checked, (next) => { selected[key] = next; renderFields(); }));
  }
  if (hasActual) {
    selection.append(checkOption('使用随机展开后的实际提示词', selected.actual, (checked) => {
      selected.actual = checked;
      renderFields();
    }));
  }
  if (selection.childElementCount) info.append(selection);
  info.append(content);
  let koreanResults = [];
  let importedResults = [];
  let koreanLoading = true;
  let artistCatalog = promptArtistCatalog(koreanResults, { loading: koreanLoading });
  function refreshArtistMatches() {
    if (revision !== screenRevision) return;
    const scroll = body.scrollTop;
    artistCatalog = promptArtistCatalog(koreanResults, { loading: koreanLoading, importedResults });
    renderArtistMatches();
    if (tagLookup.open) renderTagLookup();
    body.scrollTop = scroll;
  }
  Promise.allSettled(koreanPacks.map(([id]) => loadKoreanCatalog(id))).then((results) => {
    koreanResults = results;
    koreanLoading = false;
    refreshArtistMatches();
  });
  loadSavedNaxDirectory(revision)?.then(() => {
    if (state.online) refreshArtistMatches();
  }).catch(() => { /* The bundled and imported catalogs remain available. */ });
  loadImportedArtistCatalogs().then((results) => {
    importedResults = results;
    if (results.length) refreshArtistMatches();
  });
  const rawFields = Object.entries(data.metadata || {});
  if (rawFields.length || data.rawComment) {
    const disclosure = node('section', 'metadata-disclosure');
    const details = node('details', 'metadata-details raw-metadata');
    details.append(node('summary', '', '原始元数据'));
    const raw = node('dl', 'metadata-facts');
    for (const [key, value] of rawFields) appendCopyFact(raw, key, value, '空值', true);
    if (raw.childElementCount) details.append(raw);
    disclosure.append(details, button('复制原始数据', 'soft compact metadata-disclosure-copy',
      () => copy(rawFields.length ? data.metadata : data.rawComment)));
    info.append(disclosure);
  }

  function showArtistSample(card) {
    const scroll = body.scrollTop;
    const stateForReturn = { ...selected };
    showCard(card, 0, () => showPromptImport(data, {
      back, galleryItem, resourcePhoto,
      promptState: stateForReturn,
      promptScroll: scroll,
    }));
  }

  function addRecognizedArtists(items, targetModel) {
    const scroll = body.scrollTop;
    const stateForReturn = { ...selected };
    const cards = items.map((item) => preferredArtistRecord(item.candidates, targetModel)?.card)
      .filter(Boolean);
    if (!cards.length) {
      toast('没有可加入的库内正向画师。');
      return;
    }
    openArtistChainWorkbench({
      defaultModel: targetModel || null,
      initialArtists: cards,
      back: () => showPromptImport(data, {
        back, galleryItem, resourcePhoto,
        promptState: stateForReturn,
        promptScroll: scroll,
      }),
    });
  }

  function addWeightedArtists(weights, skipped, model) {
    const scroll = body.scrollTop;
    openArtistChainWorkbench({
      defaultModel: model, initialArtists: [...weights.keys()], originalWeights: weights, skippedWeights: skipped,
      back: () => reopenPrompt(scroll),
    });
  }

  function detectedGeneration() {
    return selectedGeneration(data, {
      positive: true, negative: true, characters: true, settings: true, actual: selected.actual,
    });
  }

  function renderTagLookup() {
    renderPromptTagLibrary(tagLookupResults, detectedGeneration(), artistCatalog, reopenPrompt,
      Number(tagLookupResults.dataset.visibleTags) || 0);
  }

  tagLookup.open = Boolean(restored?.tagLookup);
  tagLookup.addEventListener('toggle', () => { if (tagLookup.open && !tagLookupResults.childElementCount) renderTagLookup(); });

  function renderArtistMatches() {
    artistMatches.replaceChildren(renderPromptArtistUsage(
      detectedGeneration(), artistCatalog, showArtistSample, artistSampleState, addRecognizedArtists, addWeightedArtists));
  }

  function promptReturnState() {
    return {
      ...selected, tagLookup: tagLookup.open, shownTags: Number(tagLookupResults.dataset.visibleTags) || 0,
      references: references.filter((tag) => selectedReferences.has(tag.name)).map((tag) => tag.name),
    };
  }

  function reopenPrompt(scroll = body.scrollTop) {
    showPromptImport(data, {
      back, galleryItem, resourcePhoto,
      promptState: promptReturnState(),
      promptScroll: scroll,
      referenceTags: references,
      referenceSource,
      referenceSite,
      referenceSelected: [...selectedReferences],
    });
  }

  function renderReferences() {
    if (!references.length) return;
    const section = node('section', 'reference-tag-panel');
    section.append(
      node('h3', '', '参考标签'),
      node('p', 'resource-note', `${referenceSource ? `${referenceSource} · ` : ''}请选择要带走的原始标签；不会当成原图生图提示词。`),
    );
    const list = node('div', 'reference-tag-list');
    references.forEach((tag) => {
      const kind = tagGalleryKindInfo(tag.kind);
      const searchTag = PocketSources.tagGalleryTag(tag.name);
      const row = node('div', 'reference-tag-row');
      const choice = node('label', 'reference-tag-choice');
      const checkbox = node('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedReferences.has(tag.name);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedReferences.add(tag.name);
        else selectedReferences.delete(tag.name);
        renderFields();
      });
      choice.append(checkbox, node('span', 'reference-tag-name', tag.name),
        node('span', 'tag-gallery-tag-category', kind.label));
      tagDictionaryAppend(choice, tag.name, () => row.isConnected);
      const controls = node('div', 'reference-tag-actions');
      controls.append(
        button('复制原标签', 'soft compact', () => copy(tag.name)),
        button('用它搜图', 'soft compact', () => {
          const scroll = body.scrollTop;
          showTagGalleries(searchTag, () => reopenPrompt(scroll), referenceSite);
        }),
      );
      if (kind.section) {
        controls.append(button('在词库搜索', 'soft compact', () => {
          const scroll = body.scrollTop;
          searchTagGalleryInLibrary(tag, () => reopenPrompt(scroll), '返回参考标签');
        }));
        if (referenceSite === 'danbooru' && referenceSource === 'Danbooru 原始标签') {
          controls.append(tagGalleryFavoriteButton(tag, reopenPrompt));
        }
      }
      if (kind.section === 'artist') {
        controls.append(button('加入画风串', 'soft compact', () => {
          const scroll = body.scrollTop;
          openArtistChainWorkbench({
            defaultModel: null,
            initialTag: tag.name,
            back: () => reopenPrompt(scroll),
          });
        }));
      }
      row.append(choice, controls);
      list.append(row);
    });
    section.append(list);
    content.append(section);
  }

  function renderFields() {
    const scroll = body.scrollTop;
    const generation = selectedGeneration(data, selected);
    content.replaceChildren(artistMatches);
    renderArtistMatches();
    const detected = detectedGeneration();
    if (detected.prompt || detected.negativePrompt || detected.characters?.length || detected.negativeCharacters?.length) {
      content.append(tagLookup);
      if (tagLookup.open) renderTagLookup();
    }
    renderReferences();
    addCopyablePrompt(content, '正向提示词', generation.prompt);
    addCopyablePrompt(content, '负向提示词', generation.negativePrompt);
    renderCharacterPrompts(content, generation.characters, generation.negativeCharacters);
    const params = selectedGeneration(data, { settings: true, seed: true }).parameters;
    if (data.model && params.model == null) params.model = data.model;
    if (hasGeneration) {
      const settings = node('section', 'tool-section');
      const parameterHeading = node('div', 'online-pack-heading');
      parameterHeading.append(node('h2', '', '生成参数'));
      if (Object.keys(params).length) parameterHeading.append(button('复制全部生成参数', 'soft compact', () => copy(params)));
      settings.append(parameterHeading);
      const facts = node('dl', 'metadata-facts');
      const model = novelAiModelLabel(params.model || params.model_name, params.model_hash);
      appendCopyFact(facts, '模型', model);
      for (const key of new Set(['sampler', 'steps', ...Object.keys(parameterLabels), ...Object.keys(params)])) {
        if (key === 'model' && params.model === model) continue;
        const label = key === 'model' ? '原始模型标识' :
          Object.prototype.hasOwnProperty.call(parameterLabels, key) ? parameterLabels[key] : key;
        appendCopyFact(facts, label,
          Object.prototype.hasOwnProperty.call(params, key) ? params[key] : undefined,
          ['sampler', 'steps'].includes(key) ? '原图未记录' : undefined, true);
      }
      settings.append(facts);
      content.append(settings);
    }
    const json = JSON.stringify(generation, null, 2);
    const chosen = groups.some(([key]) => selected[key]);
    const chosenReferences = references.filter((tag) => selectedReferences.has(tag.name));
    const referenceOnly = references.length > 0 && !hasGeneration;
    actions.replaceChildren(button(galleryItem ? '返回原图' : sample ? '返回样图'
      : references.length ? '返回标签来源' : '另选原图', 'soft',
      back || (sample || references.length ? closeScreen : readImagePrompts)));
    const copySelection = button(hasGeneration ? '复制所选' : '复制所选参考标签', 'soft', () =>
      copy(referenceOnly
        ? chosenReferences.map((tag) => tag.name).join(' ')
        : json));
    const save = button(preparingFavorite ? '正在准备封面…' : '收藏所选', 'primary', async () => {
      if (preparingFavorite) return;
      if (new Blob([json]).size > 2 * 1024 * 1024 || generation.prompt.length > 16000) { toast('所选信息超过收藏上限，请保留原图。'); return; }
      const note = generation.negativePrompt && generation.negativePrompt.length < 7900
        ? '负向提示词：\n' + generation.negativePrompt : '已附带所选生成信息。';
      const source = resourcePhoto || {};
      preparingFavorite = true;
      save.disabled = true;
      save.textContent = '正在准备封面…';
      const cover = await promptFavoriteCover(data.preview, galleryItem, source.preview);
      if (revision !== screenRevision) return;
      showEditor({ section: 'knowledge', kind: 'general', title: sample ? '样图生成信息' : '原图生成信息',
        prompt: generation.prompt, note, photos: cover ? [{ url: cover, label: '图片预览' }] : [], generation: json,
        source: source.source, sourceUrl: source.sourceUrl });
      if (!cover) toast('小预览暂不可用，可在编辑页选择配图。');
    });
    copySelection.disabled = referenceOnly ? !chosenReferences.length : !chosen;
    save.disabled = !chosen || preparingFavorite;
    if (hasGeneration && !references.length) {
      const positivePrompt = (selected.actual ? data.actualPrompt : data.prompt)
        || data.prompt || data.actualPrompt || '';
      const finderTags = parsedPromptReferenceTags(positivePrompt);
      if (finderTags.length) {
        actions.append(button('选取正向词找图', 'soft', () => {
          const scroll = body.scrollTop;
          const stateForReturn = { ...selected };
          openTagGalleryReferenceTool(finderTags, '原图正向提示词', () => showPromptImport(data, {
            back, galleryItem, resourcePhoto,
            promptState: stateForReturn,
            promptScroll: scroll,
          }));
        }));
      }
    }
    if (references.length) {
      const findImages = button('用勾选参考标签找图', 'soft', () => {
        const value = chosenReferences
          .map((tag) => PocketSources.tagGalleryTag(tag.name))
          .filter(Boolean)
          .join(' ');
        if (!value) {
          toast('请先勾选参考标签。');
          return;
        }
        const scroll = body.scrollTop;
        showTagGalleries(value, () => reopenPrompt(scroll), referenceSite);
      });
      findImages.disabled = !chosenReferences.length;
      actions.append(findImages);
    }
    actions.append(copySelection);
    if (hasGeneration) actions.append(save);
    body.scrollTop = scroll;
  }
  renderFields();
  if (restoredScroll) {
    body.scrollTop = restoredScroll;
    requestAnimationFrame(() => {
      if (revision === screenRevision) body.scrollTop = restoredScroll;
    });
  }
}

window.PocketApp = window.PocketApp || {};
window.PocketApp.image = Object.freeze({
  readImagePrompts, showPromptImport, extractPromptTags, novelAiModelLabel,
});
