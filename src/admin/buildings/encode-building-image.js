import createJxlEncoder from '@jsquash/jxl/codec/enc/jxl_enc.js';
import { defaultOptions as defaultJxlOptions } from '@jsquash/jxl/meta.js';
import encodeWebp from '@jsquash/webp/encode.js';
import { MAX_BUILDING_IMAGE_BYTES, MAX_THUMBNAIL_BYTES } from '../../buildings/images/limits';

let jxlEncoder;

async function encodeJxl({ data, width, height }, quality) {
  jxlEncoder ??= createJxlEncoder();
  const encoded = (await jxlEncoder).encode(data, width, height, {
    ...defaultJxlOptions, effort: 3, quality, progressive: true,
  });
  if (!encoded) throw new Error('JPEG XL encoding failed');
  return encoded.slice().buffer;
}

async function encodeThumbnail(pixels) {
  let thumbnail = await encodeWebp(pixels, { quality: 72, alpha_quality: 80 });
  if (thumbnail.byteLength <= MAX_THUMBNAIL_BYTES) return thumbnail;

  // Noisy transparent images may exceed the byte budget even at low colour quality.
  const source = new OffscreenCanvas(pixels.width, pixels.height);
  source.getContext('2d').putImageData(pixels, 0, 0);
  const small = new OffscreenCanvas(pixels.width, pixels.height);
  while (thumbnail.byteLength > MAX_THUMBNAIL_BYTES) {
    small.width = Math.max(1, Math.floor(small.width / 2));
    small.height = Math.max(1, Math.floor(small.height / 2));
    const context = small.getContext('2d');
    context.drawImage(source, 0, 0, small.width, small.height);
    thumbnail = await encodeWebp(context.getImageData(0, 0, small.width, small.height), { quality: 72, alpha_quality: 80 });
  }
  return thumbnail;
}

self.onmessage = async ({ data: { pixels, thumbnail, tryLossless } }) => {
  try {
    const webpOptions = { quality: 92, use_sharp_yuv: 1 };
    let webp = await encodeWebp(pixels, webpOptions);
    if (tryLossless) {
      // In lossless mode quality controls compression effort.
      const lossless = await encodeWebp(pixels, { lossless: 1, quality: 60 });
      if (lossless.byteLength <= Math.min(webp.byteLength, MAX_BUILDING_IMAGE_BYTES))
        webp = lossless;
    }
    if (webp.byteLength > MAX_BUILDING_IMAGE_BYTES) {
      webp = await encodeWebp(pixels, {
        ...webpOptions, target_size: MAX_BUILDING_IMAGE_BYTES, pass: 4,
      });
    }

    let jxl = await encodeJxl(pixels, 90);
    if (webp.byteLength + jxl.byteLength > MAX_BUILDING_IMAGE_BYTES)
      jxl = await encodeJxl(pixels, 72);
    const thumbnailWebp = await encodeThumbnail(thumbnail);
    self.postMessage({ webp, jxl, thumbnailWebp }, [webp, jxl, thumbnailWebp]);
  } catch {
    self.postMessage(null);
  }
};
