import { createJxlTran, TransformError, type ImageInfo } from '@chimok/jxltran-js';
import jxlWasm from '../../../node_modules/@chimok/jxltran-js/dist/jxltran.wasm';
import type { ImageFiles } from './keys';
import {
  MAX_BUILDING_IMAGE_BYTES, MAX_BUILDING_IMAGE_DIMENSION, MAX_JXL_PREVIEW_BYTES,
  MAX_THUMBNAIL_BYTES, MAX_THUMBNAIL_DIMENSION,
} from './limits';

type ImageDimensions = { width: number; height: number };
let jxlParser: ReturnType<typeof createJxlTran> | undefined;

/** Inspect the encoded files. Pixel conversion runs in the uploading browser. */
export async function inspectBuildingImages(
  bytes: ImageFiles<Uint8Array<ArrayBuffer>>,
): Promise<{ jxlPreviewBytes?: number } | null> {
  if (bytes.webp.length + bytes.jxl.length > MAX_BUILDING_IMAGE_BYTES) return null;
  const webp = pixelOnlyWebpDimensions(bytes.webp);
  if (!webp || Math.max(webp.width, webp.height) > MAX_BUILDING_IMAGE_DIMENSION) return null;
  const jxl = jxlCodestreamDimensions(bytes.jxl);
  if (!jxl || jxl.width !== webp.width || jxl.height !== webp.height) return null;
  if (bytes.thumbnailWebp) {
    const thumb = pixelOnlyWebpDimensions(bytes.thumbnailWebp);
    const scale = Math.min(1, MAX_THUMBNAIL_DIMENSION / Math.max(webp.width, webp.height));
    if (!thumb || bytes.thumbnailWebp.length > MAX_THUMBNAIL_BYTES ||
        thumb.width > Math.max(1, Math.round(webp.width * scale)) ||
        thumb.height > Math.max(1, Math.round(webp.height * scale)) ||
        Math.abs(thumb.width * webp.height - thumb.height * webp.width) > Math.max(webp.width, webp.height))
      return null;
  }
  jxlParser ??= createJxlTran(typeof jxlWasm === 'string' ? undefined : jxlWasm);
  const parser = await jxlParser;
  try {
    const info = parser.info(bytes.jxl);
    if (info.orientation !== 1 || info.width !== webp.width || info.height !== webp.height || !isStillJxl(info))
      return null;
  } catch (error) {
    if (error instanceof TransformError) return null;
    throw error;
  }
  return bytes.thumbnailWebp ? { jxlPreviewBytes: previewBudget(parser, bytes.jxl) } : {};
}

function previewBudget(parser: Awaited<ReturnType<typeof createJxlTran>>, bytes: Uint8Array<ArrayBuffer>) {
  // Asking for one extra byte identifies EOF even when CORS hides Content-Range.
  if (bytes.length <= 32 * 1024) return bytes.length + 1;
  try {
    const structure = JSON.parse(parser.run(['INPUT.jxl', '--info-structure'], bytes).stdout);
    const sections: { label: string; byte_end_exclusive: number }[] = structure.codestream.frames.at(-1).toc_sections;
    // Offsets in a bare codestream include preceding low-frequency frames. A late
    // global/group section can put the first useful frame beyond the cover budget.
    let end = 0;
    for (const section of sections) {
      if (/^(?:lf_global|lf_group |hf_global|combined)/.test(section.label))
        end = Math.max(end, section.byte_end_exclusive);
    }
    if (!end) return 0;
    const budget = Math.max(end, Math.min(96 * 1024, Math.ceil(bytes.length / 3)));
    if (budget > MAX_JXL_PREVIEW_BYTES) return 0;
    return budget === bytes.length ? Math.min(budget + 1, MAX_JXL_PREVIEW_BYTES) : budget;
  } catch (error) {
    // A valid still image with no inspectable section layout can use its small WebP.
    if (error instanceof TransformError) return 0;
    throw error;
  }
}

function isStillJxl({ animation, frames, text }: ImageInfo): boolean {
  if (animation) return false;
  // jxltran counts the low-frequency frames used by progressive encoding in `frames`.
  const types = Array.from(text.matchAll(/^frame_layer: \d+ type=(\S+) /gm), match => match[1]);
  return types.length === frames.length && types.at(-1) === 'regular' &&
    types.slice(0, -1).every(type => type === 'lf');
}

const chunkName = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4));

/** Read the dimensions of one still WebP containing only pixels and optional alpha. */
function pixelOnlyWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 20 || chunkName(bytes, 0) !== 'RIFF' || chunkName(bytes, 8) !== 'WEBP')
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.length - 8) return null;

  let offset = 12;
  function takeChunk(name: string) {
    if (offset + 8 > bytes.length || chunkName(bytes, offset) !== name) return false;
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size;
    if (!size || end > bytes.length || (size % 2 && bytes[end] !== 0)) return false;
    offset = end + (size % 2);
    return true;
  }

  let canvas: { width: number; height: number } | undefined;
  if (chunkName(bytes, offset) === 'VP8X') {
    // Extended browser output only needs the alpha flag and a separate alpha chunk.
    if (bytes.length < 30 || view.getUint32(16, true) !== 10 ||
        view.getUint32(20) !== 0x10000000 || !takeChunk('VP8X') || !takeChunk('ALPH'))
      return null;
    const dimension = (at: number) => 1 + bytes[at] + (bytes[at + 1] << 8) + (bytes[at + 2] << 16);
    canvas = { width: dimension(24), height: dimension(27) };
  }

  const data = offset + 8;
  if (takeChunk('VP8 ')) {
    const length = view.getUint32(data - 4, true);
    if (offset !== bytes.length || length <= 10 || (bytes[data] & 1) ||
        bytes[data + 3] !== 0x9d || bytes[data + 4] !== 1 || bytes[data + 5] !== 0x2a)
      return null;
    const firstPartitionSize = (bytes[data] + (bytes[data + 1] << 8) + (bytes[data + 2] << 16)) >>> 5;
    if (!firstPartitionSize || firstPartitionSize > length - 10) return null;
    const width = view.getUint16(data + 6, true) & 0x3fff;
    const height = view.getUint16(data + 8, true) & 0x3fff;
    if (!width || !height || (canvas && (canvas.width !== width || canvas.height !== height)))
      return null;
    return { width, height };
  }
  if (canvas || !takeChunk('VP8L') || offset !== bytes.length || view.getUint32(data - 4, true) <= 5 ||
      bytes[data] !== 0x2f || bytes[data + 4] >> 5)
    return null;
  const dimensions = view.getUint32(data + 1, true);
  return { width: (dimensions & 0x3fff) + 1, height: ((dimensions >>> 14) & 0x3fff) + 1 };
}

// The browser encoder emits a raw codestream. Inspect its size header without decoding pixels.
function jxlCodestreamDimensions(bytes: Uint8Array<ArrayBuffer>): ImageDimensions | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0x0a) return null;
  let offset = 16;
  function read(count: number) {
    let value = 0;
    for (let bit = 0; bit < count; bit++, offset++) {
      value |= ((bytes[offset >>> 3] >> (offset & 7)) & 1) << bit;
    }
    return value;
  }
  const small = read(1) === 1;
  const dimension = () => small ? (read(5) + 1) * 8 : read([9, 13, 18, 30][read(2)]) + 1;
  const height = dimension();
  const ratio = [null, [1, 1], [12, 10], [4, 3], [3, 2], [16, 9], [5, 4], [2, 1]][read(3)];
  const width = ratio ? Math.floor((height * ratio[0]) / ratio[1]) : dimension();
  return offset <= (bytes.length - 1) * 8 ? { width, height } : null;
}
