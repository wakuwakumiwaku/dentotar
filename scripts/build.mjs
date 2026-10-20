import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const catalogPath = path.join(root, 'public/data/catalog.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8').catch(() => { throw new Error('Tarifdaten fehlen. Zuerst npm run data ausführen.'); }));
if (catalog.schemaVersion !== 1 || !catalog.positions?.length) throw new Error('Tarifdaten ungültig.');
const dist = path.join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist);
await cp(path.join(root, 'index.html'), path.join(dist, 'index.html'));
await cp(path.join(root, 'src'), path.join(dist, 'src'), { recursive: true });
await cp(path.join(root, 'public'), dist, { recursive: true });
console.log(`Lokaler statischer Build: ${dist} (${catalog.positions.length} Positionen). Nicht ohne Rechteklärung veröffentlichen.`);
