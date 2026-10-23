import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const frontend = new URL('../frontend/', import.meta.url);
const sandbox = { URL };
sandbox.self = sandbox;
vm.runInNewContext(readFileSync(new URL('sw-policy.js', frontend), 'utf8'), sandbox);
const { classify, SHELL_FILES, SDK_URLS } = sandbox.SwPolicy;
const origin = 'https://adart96.github.io';

test('same-origin GET requests are handled by the service worker', () => {
  assert.equal(classify(`${origin}/RACE_WEBAPP_LITE/frontend/app.html?x=1`, 'GET', origin), 'same-origin');
  assert.equal(classify(`${origin}/RACE_WEBAPP_LITE/frontend/js/roles.js`, 'GET', origin), 'same-origin');
});

test('Firebase SDK modules are cached', () => {
  for (const url of SDK_URLS) assert.equal(classify(url, 'GET', origin), 'sdk');
});

test('Google API traffic and non-GET requests are never touched', () => {
  const skipped = [
    'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel',
    'https://race-webapp-lite.firebaseio.com/x',
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword',
    'https://securetoken.googleapis.com/v1/token',
    'https://script.google.com/macros/s/abc/exec',
    'https://www.gstatic.com/firebasejs/10.7.0/other.js',
    'chrome-extension://abc/x.js'
  ];
  for (const url of skipped) assert.equal(classify(url, 'GET', origin), 'skip', url);
  assert.equal(classify(`${origin}/RACE_WEBAPP_LITE/frontend/app.html`, 'POST', origin), 'skip');
});

test('precache list covers every page, stylesheet and module in frontend', () => {
  const walk = (dir, ext) => readdirSync(new URL(dir, frontend)).filter(name => name.endsWith(ext)).map(name => dir + name);
  const expected = [...walk('', '.html'), ...walk('css/', '.css'), ...walk('js/', '.js')]
    .filter(file => !file.endsWith('firebase-config.example.js'));
  for (const file of expected) assert.ok(SHELL_FILES.includes(file), `${file} missing from SHELL_FILES`);
  for (const file of SHELL_FILES) assert.ok(existsSync(new URL(file, frontend)), `${file} listed but missing`);
});
