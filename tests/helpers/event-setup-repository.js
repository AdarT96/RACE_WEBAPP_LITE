import { readFile } from 'node:fs/promises';

// Exercise the browser repository unchanged against the real Firestore SDK in
// the local emulator, resolving its browser CDN import to the installed SDK.
const url = new URL('../../frontend/js/event-setup-repository.js', import.meta.url);
const source = (await readFile(url, 'utf8'))
  .replace(/from 'https:\/\/www.gstatic.com\/firebasejs\/[^']+'/g, `from '${import.meta.resolve('firebase/firestore')}'`)
  .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
export const { createEventSetupRepository } = await import(`data:text/javascript;base64,${Buffer.from(source + '\n//# sourceURL=event-setup-repository.test.js').toString('base64')}`);
