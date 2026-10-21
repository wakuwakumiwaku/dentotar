import { fixed } from './domain.js';

export const MAX_CATALOG_BYTES = 20 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 1000) => typeof value === 'string' && value.length <= max;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,60}$/.test(value);
const fail = () => { throw new Error('Katalogformat ungültig. Bitte die vom Projekt erzeugte catalog.json öffnen, keine Plan-Sicherung.'); };

function list(value, max, check) {
  if (!Array.isArray(value) || value.length > max || value.some(item => !check(item))) fail();
}

export function safeSourceURL(value) {
  try {
    if (!text(value, 2048)) return '#';
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '#';
  } catch { return '#'; }
}

export function validateCatalog(input) {
  if (!object(input) || input.schemaVersion !== 1 || !text(input.version, 120) || !input.version.trim()
    || !Array.isArray(input.positions) || !input.positions.length) fail();
  for (const key of ['chapters', 'sections']) {
    list(input[key], 10000, row => object(row) && identifier(row.id) && text(row.title)
      && (row.notes == null || text(row.notes, 250000)));
    if (new Set(input[key].map(row => row.id)).size !== input[key].length) fail();
  }
  list(input.sources, 30, source => object(source) && text(source.id, 80) && text(source.title)
    && (source.version == null || text(source.version)) && safeSourceURL(source.url) !== '#'
    && (source.sha256 == null || (typeof source.sha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(source.sha256))));
  if (!input.sources.length || new Set(input.sources.map(row => row.id)).size !== input.sources.length) fail();
  if (input.notices !== undefined) list(input.notices, 1000, note => text(note, 10000));
  const chapters = new Set(input.chapters.map(row => row.id));
  const sections = new Set(input.sections.map(row => row.id));
  const codes = new Set();
  list(input.positions, 20000, row => {
    if (!object(row) || !identifier(row.code) || codes.has(row.code) || !text(row.title)
      || !text(row.kind, 80) || !chapters.has(row.chapter) || !sections.has(row.section)) return false;
    codes.add(row.code);
    for (const key of ['shortTitle', 'coverage', 'validity', 'vat', 'notes']) {
      if (row[key] != null && !text(row[key], key === 'notes' ? 250000 : 1000)) return false;
    }
    for (const key of ['socialPoints', 'privateMin', 'privateMax']) {
      const value = row[key];
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000)) return false;
      if (value !== null) { try { fixed(value); } catch { return false; } }
    }
    if (row.privateMin !== null && row.privateMax !== null && row.privateMin > row.privateMax) return false;
    for (const key of ['excludes', 'members', 'packages']) list(row[key], 20000, identifier);
    if (row.sourcePage != null && (!Number.isInteger(row.sourcePage) || row.sourcePage < 1 || row.sourcePage > 50000)) return false;
    if (row.amountsCHF != null) {
      if (!object(row.amountsCHF)) return false;
      for (const key of ['private', 'social']) {
        const value = row.amountsCHF[key];
        if (value != null) {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000) return false;
          try { fixed(value); } catch { return false; }
        }
      }
    }
    return true;
  });
  return input;
}

export function parseCatalog(raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_CATALOG_BYTES) {
    throw new Error('Katalogdatei zu gross (maximal 20 MB).');
  }
  let input;
  try { input = JSON.parse(raw); } catch { throw new Error('Keine lesbare JSON-Katalogdatei.'); }
  return validateCatalog(input);
}
