import { readFile } from 'node:fs/promises';
const url = new URL('../../frontend/js/arrival-repository.js', import.meta.url);
const firestoreUrl = import.meta.resolve('firebase/firestore');
const source = (await readFile(url, 'utf8'))
  .replace(/from 'https:\/\/www.gstatic.com\/firebasejs\/[^']+'/g, `from '${firestoreUrl}'`)
  .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
const real = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { waitForPendingWrites } = await import(firestoreUrl);

// The repository writes local-first and reports the server's answer later. For
// rule tests each mutate waits for that answer and fails when the server refused.
export function createArrivalRepository(db, user, stateForRace) {
  const refused = [];
  const repository = real.createArrivalRepository(db, user, stateForRace, { onWriteError: error => refused.push(error) });
  return {
    ...repository,
    async mutate(raceId, command) {
      const result = await repository.mutate(raceId, command);
      await waitForPendingWrites(db);
      await new Promise(resolve => setTimeout(resolve, 20));
      if (refused.length) throw refused.splice(0)[0];
      return result;
    }
  };
}
