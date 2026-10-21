import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCatalog } from '../src/catalog.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const PAGE_FILES = Object.freeze([
  ['index.html', 'index.html'],
  ['src/app.js', 'src/app.js'],
  ['src/catalog.js', 'src/catalog.js'],
  ['src/domain.js', 'src/domain.js'],
  ['src/styles.css', 'src/styles.css'],
  ['public/favicon.svg', 'favicon.svg'],
  ['public/data/catalog.json', 'data/catalog.json'],
  ['public/data/source-tariff.pdf', 'data/source-tariff.pdf'],
  ['public/data/source-shorttext.pdf', 'data/source-shorttext.pdf'],
]);

// Publish only the explicitly selected runtime files, never public/ wholesale or personal exports.
export async function buildPages(root = ROOT) {
  const output = path.join(root, 'dist-pages');
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  if (!html.includes('</head>')) throw new Error('HTML-Einstieg fehlt.');
  parseCatalog(await readFile(path.join(root, 'public/data/catalog.json'), 'utf8'));
  await rm(output, { recursive: true, force: true });
  await mkdir(output);
  for (const [source, target] of PAGE_FILES) {
    const destination = path.join(output, target);
    await mkdir(path.dirname(destination), { recursive: true });
    if (source === 'index.html') {
      await writeFile(destination, html.replace('</head>', `  <meta name="dentotar-catalog" content="hosted">\n  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'">\n</head>`));
    } else await cp(path.join(root, source), destination);
  }
  await writeFile(path.join(output, '.nojekyll'), '');
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Öffentlicher Tarifbrowser-Build: ${await buildPages()} (mit Katalog und Original-PDFs, ohne persönliche Pläne).`);
}
