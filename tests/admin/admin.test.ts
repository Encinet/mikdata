import { expect, test } from 'bun:test';
import { BUILDING_EDITOR_SCRIPT } from '../../src/admin/buildings/editor';
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

test('the building editor preserves commas, quotes and line breaks in form rows', () => {
  const fields = new Map<string, { value: string; addEventListener: () => void }>();
  const field = (id: string) => {
    if (!fields.has(id)) fields.set(id, { value: '', addEventListener: () => {} });
    return fields.get(id)!;
  };
  const { fillForm, toPayload } = new Function(
    '$', 'gallery', BUILDING_EDITOR_SCRIPT + '\nreturn { fillForm, toPayload };',
  )(field, { images: [] });
  const builders = [{ name: 'Builder, "One"', uuid: '00000000-0000-4000-8000-000000000001', weight: 42 }];
  const tags = [{ 'zh-CN': '山谷,桥', en: 'First line\n"Second line"' }, { 'zh-CN': '', en: 'Plain' }];
  fillForm({ builders, tags });
  expect(toPayload()).toMatchObject({ builders, tags });
  field('tags').value = '甲,Beta,extra';
  expect(toPayload).toThrow('标签字段过多');
  field('tags').value = '"missing end quote';
  expect(toPayload).toThrow('标签的引号格式不正确');
});
