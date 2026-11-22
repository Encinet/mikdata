import { expect, test } from 'bun:test';
import { adminPage } from '../../src/admin/page';

test('admin CSP scopes storage previews to the image origin and scripts to nonces', async () => {
  const response = adminPage('https://images.example/gallery');
  const csp = response.headers.get('Content-Security-Policy') ?? '';

  expect(csp).toContain("style-src 'nonce-");
  expect(csp).toContain("script-src 'nonce-");
  expect(csp).toContain("img-src 'self' https://images.example;");
  expect(csp).not.toContain('unsafe-inline');
  const html = await response.text();
  for (const script of html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)) {
    expect(() => new Function(script[1])).not.toThrow();
  }
});

test('the sponsor workspace has its own navigation state and compilable script', async () => {
  const html = await adminPage(undefined, 'sponsors').text();
  expect(html).toContain('href="/admin/sponsors" aria-current="page"');
  expect(html).toContain('id="sponsor-dialog"');
  expect(html).not.toContain('id="buildings-panel"');
  for (const script of html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)) {
    expect(() => new Function(script[1])).not.toThrow();
  }
});
