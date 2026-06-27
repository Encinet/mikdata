import { expect, test } from 'bun:test';
import { adminPage } from '../src/admin';

test('admin page CSP uses nonces instead of unsafe-inline', () => {
  const response = adminPage();
  const csp = response.headers.get('Content-Security-Policy') ?? '';

  expect(csp).toContain("style-src 'nonce-");
  expect(csp).toContain("script-src 'nonce-");
  expect(csp).not.toContain('unsafe-inline');
});
