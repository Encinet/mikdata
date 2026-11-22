// Compact MD5 (RFC 1321) with hex output.
// Cloudflare Workers' crypto.subtle does not support MD5, but the Afdian
// open API signs requests with it:
//   sign = md5(token + "params" + params + "ts" + ts + "user_id" + userId)
// where params is a compact JSON string.

const K = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32),
);
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const rotl = (x: number, c: number): number => (x << c) | (x >>> (32 - c));

export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const byteLength = bytes.length;
  const bitLength = byteLength * 8;
  const paddedLength = (((byteLength + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[byteLength] = 0x80;
  const lengthView = new DataView(buffer.buffer);
  lengthView.setUint32(paddedLength - 8, bitLength >>> 0, true);
  lengthView.setUint32(paddedLength - 4, Math.floor(bitLength / 2 ** 32), true);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const words = new Int32Array(16);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      words[i] =
        buffer[offset + i * 4] |
        (buffer[offset + i * 4 + 1] << 8) |
        (buffer[offset + i * 4 + 2] << 16) |
        (buffer[offset + i * 4 + 3] << 24);
    }

    const aa = a;
    const bb = b;
    const cc = c;
    const dd = d;

    // Standard RFC 1321 step:
    //   F = (B & C) | (~B & D);  G = i
    //   F = (D & B) | (~D & C);  G = (5i + 1) mod 16
    //   F = B ^ C ^ D;           G = (3i + 5) mod 16
    //   F = C ^ (B | ~D);       G = (7i) mod 16
    // T = A; A = D + F + K[i] + X[g]; D = C; C = B; B = T + leftrotate(T + F + K[i] + X[g], S[i])
    // (equivalently B += leftrotate(F + K[i] + X[g] + B, S[i]) when T is carried separately)
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const temp = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + K[i] + words[g]) | 0, S[i])) | 0;
      a = temp;
    }

    a = (a + aa) | 0;
    b = (b + bb) | 0;
    c = (c + cc) | 0;
    d = (d + dd) | 0;
  }

  const out = new DataView(new ArrayBuffer(16));
  for (const [index, value] of [a, b, c, d].entries()) {
    out.setUint32(index * 4, value >>> 0, true);
  }
  return Array.from(new Uint8Array(out.buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function afdianSign(
  token: string,
  userId: string,
  paramsJson: string,
  tsSeconds: number,
): string {
  return md5Hex(`${token}params${paramsJson}ts${tsSeconds}user_id${userId}`);
}
