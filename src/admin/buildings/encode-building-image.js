import createJxlEncoder from '@jsquash/jxl/codec/enc/jxl_enc.js';
import { defaultOptions as defaultJxlOptions } from '@jsquash/jxl/meta.js';
import encodeWebp from '@jsquash/webp/encode.js';
import { MAX_BUILDING_IMAGE_BYTES } from '../../buildings/images/limits';

let jxlEncoder;

async function encodeJxl({ data, width, height }, quality) {
  jxlEncoder ??= createJxlEncoder();
  const encoded = (await jxlEncoder).encode(data, width, height, {
    ...defaultJxlOptions, effort: 3, quality, progressive: true,
  });
  if (!encoded) throw new Error('JPEG XL encoding failed');
  return encoded.slice().buffer;
}

self.onmessage = async ({ data: { pixels, tryLossless } }) => {
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
    self.postMessage({ webp, jxl }, [webp, jxl]);
  } catch {
    self.postMessage(null);
  }
};
