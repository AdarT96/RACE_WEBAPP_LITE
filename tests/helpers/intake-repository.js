import { readFile } from 'node:fs/promises';

// The browser intake repository, unchanged, against the installed Firestore SDK
// and the local emulator (same approach as the other repository helpers).
const url = new URL('../../frontend/js/intake-repository.js', import.meta.url);
const source = (await readFile(url, 'utf8'))
  .replace(/from 'https:\/\/www.gstatic.com\/firebasejs\/[^']+'/g, `from '${import.meta.resolve('firebase/firestore')}'`)
  .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
export const { createIntakeRepository, IntakeMoveBlockedError } = await import(`data:text/javascript;base64,${Buffer.from(source + '\n//# sourceURL=intake-repository.test.js').toString('base64')}`);
