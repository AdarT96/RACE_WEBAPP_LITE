import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const parse5 = require('parse5');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function filesIn(directory, extension) {
  return readdirSync(directory, { withFileTypes:true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path, extension) : path.endsWith(extension) ? [path] : [];
  });
}

function validateHtml(file) {
  const source = readFileSync(file, 'utf8');
  const errors = [];
  const document = parse5.parse(source, { sourceCodeLocationInfo:true, onParseError:error => errors.push(error) });
  if (errors.length) {
    const error = errors[0];
    throw new Error(`${relative(root, file)}:${error.startLine}:${error.startCol} ${error.code}`);
  }
  const ids = [];
  const visit = node => {
    const id = node?.attrs?.find(attribute => attribute.name === 'id')?.value;
    if (id) ids.push(id);
    (node?.childNodes || []).forEach(visit);
    if (node?.content) visit(node.content);
  };
  visit(document);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) throw new Error(`${relative(root, file)} contains duplicate ids: ${[...new Set(duplicates)].join(', ')}`);
  for (const match of source.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
    const target = match[1];
    if (/^(?:https?:|#|data:)/.test(target)) continue;
    const local = resolve(file, '..', target.split(/[?#]/)[0]);
    if (!existsSync(local)) throw new Error(`${relative(root, file)} references missing file ${target}`);
  }
}

const htmlFiles = [join(root, 'index.html'), ...filesIn(join(root, 'frontend'), '.html')];
const javascriptFiles = filesIn(join(root, 'frontend', 'js'), '.js');

htmlFiles.forEach(validateHtml);
javascriptFiles.forEach(file => {
  execFileSync(process.execPath, ['--check', file], { stdio:'pipe' });
  const source = readFileSync(file, 'utf8');
  const importPatterns = [
    /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  importPatterns.forEach(pattern => {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const local = resolve(file, '..', specifier.split(/[?#]/)[0]);
      if (!existsSync(local)) {
        throw new Error(`${relative(root, file)} imports missing module ${specifier}`);
      }
    }
  });
});

for (const required of ['firebase.json', 'firestore.rules', 'firestore.indexes.json']) {
  if (!existsSync(join(root, required))) throw new Error(`Missing deployment source: ${required}`);
}
JSON.parse(readFileSync(join(root, 'firestore.indexes.json'), 'utf8'));

console.log(`Static validation passed: ${htmlFiles.length} HTML files, ${javascriptFiles.length} JavaScript modules.`);
