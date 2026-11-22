export const MAX_AUTH_BODY_BYTES = 64 * 1024;

export class RequestBodyTooLargeError extends Error {}

export async function readLimitedRequestText(
  request: Request,
  maxBytes = MAX_AUTH_BODY_BYTES,
): Promise<string> {
  const contentLength = request.headers.get('content-length');

  if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
    throw new RequestBodyTooLargeError('request body too large');
  }

  if (!request.body) {
    return '';
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLargeError('request body too large');
    }

    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
