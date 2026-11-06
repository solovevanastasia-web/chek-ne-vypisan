import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

test('publication guard passes and env is ignored', () => {
  const cwd = new URL('../', import.meta.url);
  const output = execFileSync(process.execPath, ['scripts/check-publication.mjs'], { cwd, encoding: 'utf8' });
  assert.match(output, /PASS:/);
  const ignored = execFileSync('git', ['check-ignore', 'env/.env', 'env/deploy_key', 'env/github/hosts.yml'], { cwd, encoding:'utf8' });
  for (const file of ['env/.env','env/deploy_key','env/github/hosts.yml']) assert.ok(ignored.includes(file));
  assert.equal(execFileSync('git',['ls-files','env/'],{cwd,encoding:'utf8'}),'');
});

test('PWA manifest and referenced app assets exist', () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url)));
  assert.equal(manifest.display,'standalone');
  assert.equal(manifest.start_url,'/');
  assert.ok(manifest.icons.some(i=>i.sizes==='192x192'));
  assert.ok(manifest.icons.some(i=>i.sizes==='512x512'));
  for (const icon of manifest.icons) assert.ok(readFileSync(new URL('../public'+icon.src,import.meta.url)).length>0);
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  for (const match of html.matchAll(/(?:src|href)="(\/[^"?#]*)(?:\?[^"#]*)?"/g)) {
    if (match[1]!=='/') assert.ok(readFileSync(new URL('../public'+match[1],import.meta.url)).length>0);
  }
});
