import { copyFile, mkdir, rm } from 'node:fs/promises';

const directory = 'dist/admin-assets/building-codec';
const jxl = 'node_modules/@jsquash/jxl';
const webp = 'node_modules/@jsquash/webp';
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
await Bun.build({
  entrypoints: ['src/admin/buildings/encode-building-image.js'],
  outdir: directory,
  target: 'browser',
  format: 'esm',
  minify: true,
  throw: true,
});

// The encoder modules load these binaries relative to the worker bundle.
await Promise.all([
  copyFile(jxl + '/codec/enc/jxl_enc.wasm', directory + '/jxl_enc.wasm'),
  copyFile(jxl + '/LICENSE', directory + '/LICENSE-jxl'),
  copyFile(webp + '/codec/enc/webp_enc.wasm', directory + '/webp_enc.wasm'),
  copyFile(webp + '/codec/enc/webp_enc_simd.wasm', directory + '/webp_enc_simd.wasm'),
  copyFile(webp + '/LICENSE', directory + '/LICENSE-webp'),
]);
