import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageStorageConfig, prepareImagePut, sha256, verifyOriginal } from '../../src/buildings/images/storage';

// biome-ignore-start lint/style/useNamingConvention: Environment fixtures use the deployment variable names.
test('S3 signs the WebP hash against the bucket and verifies the public original', async () => {
  const config = imageStorageConfig({
    BUILDING_IMAGE_S3_BUCKET_URL: 'https://s3.example/test-bucket/',
    BUILDING_IMAGE_S3_REGION: 'eu-west-1',
    BUILDING_IMAGE_PUBLIC_BASE_URL: 'https://cdn.example/gallery/',
    BUILDING_IMAGE_ACCESS_KEY_ID: 'test',
    BUILDING_IMAGE_SECRET_ACCESS_KEY: 'test',
  });
  assert.ok(config);
  const bytes = new Uint8Array([1, 2, 3]);
  const hash = await sha256(bytes);
  const key = `buildings/${'f'.repeat(32)}/${hash}.webp`;
  const put = await prepareImagePut(config, key);
  const headers = new Headers(put.headers);
  assert.equal(put.url, `https://s3.example/test-bucket/${key}`);
  assert.equal(config.publicBaseUrl, 'https://cdn.example/gallery');
  assert.match(headers.get('Authorization') ?? '', /eu-west-1\/s3\/aws4_request/);
  assert.equal(headers.get('x-amz-content-sha256'), hash);
  assert.equal(headers.get('Content-Type'), 'image/webp');

  const original = (body: Uint8Array<ArrayBuffer>) =>
    new Response(body, { headers: { 'Content-Type': 'image/webp' } });
  await verifyOriginal(original(bytes), hash, bytes.length);
  await assert.rejects(verifyOriginal(original(new Uint8Array([3, 2, 1])), hash, bytes.length), /checksum/);
});

test('uploads require an explicit HTTPS bucket URL and signing region', () => {
  const url = 'https://storage.example/my-bucket';
  const env = {
    NODE_ENV: 'test' as const,
    BUILDING_IMAGE_S3_BUCKET_URL: url,
    BUILDING_IMAGE_S3_REGION: 'eu-west-1',
    BUILDING_IMAGE_ACCESS_KEY_ID: 'test',
    BUILDING_IMAGE_SECRET_ACCESS_KEY: 'test',
  };
  const config = imageStorageConfig(env);
  assert.equal(config?.bucketUrl, url);
  assert.equal(config?.publicBaseUrl, url);
  assert.equal(config?.region, env.BUILDING_IMAGE_S3_REGION);
  assert.equal(imageStorageConfig({ ...env, BUILDING_IMAGE_S3_REGION: '' }), null);
  assert.equal(imageStorageConfig({ ...env, BUILDING_IMAGE_S3_BUCKET_URL: '' }), null);
  for (const value of [
    'broken',
    'http://bucket',
    'https://a:b@bucket',
    'https://bucket?q',
    'https://bucket/#x',
  ]) {
    assert.equal(imageStorageConfig({ ...env, BUILDING_IMAGE_S3_BUCKET_URL: value }), null);
    assert.equal(imageStorageConfig({ ...env, BUILDING_IMAGE_PUBLIC_BASE_URL: value }), null);
  }
});
// biome-ignore-end lint/style/useNamingConvention: End of environment fixtures.
