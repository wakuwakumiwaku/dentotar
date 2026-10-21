import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const PAGE_FILES = Object.freeze([
  ['index.html', 'index.html'],
  ['src/app.js', 'src/app.js'],
  ['src/catalog.js', 'src/catalog.js'],
  ['src/domain.js', 'src/domain.js'],
  ['src/styles.css', 'src/styles.css'],
  ['public/favicon.svg', 'favicon.svg'],
]);

// Intentionally independent of the local full-data build. Never copy public/ wholesale.
export async function buildPages(root = ROOT) {
  const output = path.join(root, 'dist-pages');
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  if (!html.includes('</head>')) throw new Error('HTML-Einstieg fehlt.');
  await rm(output, { recursive: true, force: true });
  await mkdir(output);
  for (const [source, target] of PAGE_FILES) {
    const destination = path.join(output, target);
    await mkdir(path.dirname(destination), { recursive: true });
    if (source === 'index.html') {
      await writeFile(destination, html.replace('</head>', `  <meta name="dentotar-catalog" content="local-file">\n  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'">\n</head>`));
    } else await cp(path.join(root, source), destination);
  }
  await writeFile(path.join(output, '.nojekyll'), '');
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Öffentlicher Code-only-Build: ${await buildPages()} (ohne Tarifdateien oder persönliche Pläne).`);
}
