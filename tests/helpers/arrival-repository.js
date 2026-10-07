import { readFile } from 'node:fs/promises';
const url = new URL('../../frontend/js/arrival-repository.js', import.meta.url);
const source = (await readFile(url, 'utf8'))
  .replace(/from 'https:\/\/www.gstatic.com\/firebasejs\/[^']+'/g, `from '${import.meta.resolve('firebase/firestore')}'`)
  .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
export const { createArrivalRepository } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
