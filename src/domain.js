const HUNDRED = 100n;
export const SCHEMA_VERSION = 1;
export const LIMITS = Object.freeze({ lines: 200, quantity: 999, savedPlans: 30, favorites: 2000 });
const VALID_MODES = new Set(['private', 'social']);
const VALID_LEVELS = new Set(['reference', 'min', 'max']);
const CODE_COLLATOR = new Intl.Collator('de-CH', { numeric: true });

export function fixed(value, places = 2) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Ungültige Zahl.');
  const text = String(value).trim().replace(',', '.');
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[2] || '').length > places || match[1].length > 9) {
    throw new Error(`Bitte eine positive Zahl mit höchstens ${places} Nachkommastellen eingeben.`);
  }
  return BigInt(match[1]) * 10n ** BigInt(places) + BigInt((match[2] || '').padEnd(places, '0') || '0');
}

export function decimal(value, places = 2) {
  const n = BigInt(value);
  const divisor = 10n ** BigInt(places);
  return `${n / divisor}.${String(n % divisor).padStart(places, '0')}`;
}

function number(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Der Betrag ist zu gross.');
  return Number(value);
}

export function moneyCents(points, rate, quantity = 1) {
  const p = fixed(points, 2);
  const r = fixed(rate, 4);
  if (r <= 0n || r > 10_000_000n) throw new Error('Der Taxpunktwert muss grösser als 0 und höchstens 1000 CHF sein.');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > LIMITS.quantity) throw new Error('Ungültige Anzahl.');
  return number((p * r * BigInt(quantity) + 5000n) / 10000n);
}

export function normalize(text) {
  return String(text).toLowerCase().replaceAll('ä', 'ae').replaceAll('ö', 'oe').replaceAll('ü', 'ue')
    .replaceAll('ß', 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

export function buildSearchIndex(positions) {
  return positions.map(position => {
    const code = normalize(position.code);
    return { position, code, compactCode: code.replaceAll('.', ''),
      title: normalize(`${position.title} ${position.shortTitle || ''}`),
      haystack: normalize(`${position.code} ${position.title} ${position.shortTitle || ''} ${position.notes || ''}`) };
  });
}

export function search(index, query = '', { chapter = '', favorites = null } = {}) {
  const q = normalize(query);
  const tokens = q.split(' ').filter(Boolean);
  const compact = q.replaceAll('.', '');
  return index.filter(row => (!chapter || row.position.chapter === chapter)
    && (!favorites || favorites.has(row.position.code))
    && tokens.every(token => row.haystack.includes(token) || row.compactCode.includes(token)))
    .map(row => ({ row, score: !q ? 0 : row.code === q || row.compactCode === compact ? 0
      : row.code.startsWith(q) ? 1 : row.title.startsWith(q) ? 2
        : tokens.every(t => row.title.includes(t)) ? 3 : 4 }))
    .sort((a, b) => a.score - b.score || CODE_COLLATOR.compare(a.row.position.code, b.row.position.code))
    .map(item => item.row.position);
}

export function defaultPoints(position, mode, level = 'reference') {
  if (mode === 'social') return position.socialPoints ?? null;
  if (position.privateMin == null || position.privateMax == null) return null;
  if (level === 'min') return position.privateMin;
  if (level === 'max') return position.privateMax;
  const reference = position.socialPoints;
  if (reference != null && reference >= position.privateMin && reference <= position.privateMax) return reference;
  return Number(decimal((fixed(position.privateMin) + fixed(position.privateMax) + 1n) / 2n));
}

export function fixedAmount(position, mode) {
  return position.amountsCHF?.[mode === 'social' ? 'social' : 'private'] ?? null;
}

export function createPlan() { return { title: 'Neue Zusammenstellung', lines: [] }; }
export function createState() {
  return { schemaVersion: SCHEMA_VERSION, mode: 'private', taxPointValue: '1.00', privateLevel: 'reference',
    plan: createPlan(), favorites: [], savedPlans: [] };
}

export function validatePlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.title !== 'string'
      || input.title.length > 160 || !Array.isArray(input.lines) || input.lines.length > LIMITS.lines) {
    throw new Error('Ungültige Zusammenstellung oder zu viele Positionen.');
  }
  const ids = new Set();
  const lines = input.lines.map(line => {
    if (!line || typeof line.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(line.id) || ids.has(line.id)
        || typeof line.code !== 'string' || line.code.length > 60
        || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > LIMITS.quantity
        || typeof line.note !== 'string' || line.note.length > 1000
        || (line.points !== null && typeof line.points !== 'string')) throw new Error('Ungültige Position in der Datei.');
    if (line.points !== null && fixed(line.points) > 100_000_000n) throw new Error('Taxpunkte sind zu gross.');
    ids.add(line.id);
    return { id: line.id, code: line.code, quantity: line.quantity, points: line.points, note: line.note };
  });
  return { title: input.title, lines };
}

function validateSettings(input) {
  if (!VALID_MODES.has(input.mode) || !VALID_LEVELS.has(input.privateLevel) || typeof input.taxPointValue !== 'string') {
    throw new Error('Ungültige Tarifeinstellungen.');
  }
  moneyCents('0', input.taxPointValue);
  return { mode: input.mode, privateLevel: input.privateLevel, taxPointValue: input.taxPointValue };
}

export function validateState(input) {
  if (!input || input.schemaVersion !== SCHEMA_VERSION || !Array.isArray(input.favorites)
      || input.favorites.length > LIMITS.favorites || input.favorites.some(x => typeof x !== 'string' || x.length > 60)
      || !Array.isArray(input.savedPlans) || input.savedPlans.length > LIMITS.savedPlans) throw new Error('Unbekanntes Speicherformat.');
  return { schemaVersion: SCHEMA_VERSION, ...validateSettings(input), plan: validatePlan(input.plan),
    favorites: [...new Set(input.favorites)], savedPlans: input.savedPlans.map(saved => {
      if (!saved || typeof saved.id !== 'string' || typeof saved.savedAt !== 'string' || typeof saved.catalogVersion !== 'string') {
        throw new Error('Ungültige gespeicherte Zusammenstellung.');
      }
      return { id: saved.id, savedAt: saved.savedAt, catalogVersion: saved.catalogVersion,
        ...validateSettings(saved), plan: validatePlan(saved.plan) };
    }) };
}

export function exportPlan(state, catalogVersion) {
  return { kind: 'dentotar-plan', schemaVersion: SCHEMA_VERSION, catalogVersion,
    exportedAt: new Date().toISOString(), ...validateSettings(state), plan: validatePlan(state.plan) };
}

export function importPlan(input, currentVersion) {
  if (!input || input.kind !== 'dentotar-plan' || input.schemaVersion !== SCHEMA_VERSION
      || typeof input.catalogVersion !== 'string') throw new Error('Keine unterstützte DENTOTAR-Zusammenstellung.');
  return { ...validateSettings(input), plan: validatePlan(input.plan),
    versionMismatch: input.catalogVersion !== currentVersion };
}

export function calculatePlan(state, positions) {
  const lookup = positions instanceof Map ? positions : new Map(positions.map(p => [p.code, p]));
  const settingsErrors = [];
  try { moneyCents('0', state.taxPointValue); } catch (error) { settingsErrors.push(error.message); }
  let total = 0n;
  let pointsTotal = 0n;
  const lines = state.plan.lines.map(line => {
    const position = lookup.get(line.code);
    const errors = [];
    let points = null, amountCents = null, amountCHF = null;
    try {
      if (!position) throw new Error('Position nicht im geladenen Katalog.');
      amountCHF = fixedAmount(position, state.mode);
      if (amountCHF !== null) {
        if (state.mode === 'private' && line.points !== null) throw new Error('CHF-Fixbeträge erlauben keinen Taxpunkt-Override.');
        amountCents = moneyCents(amountCHF, '1', line.quantity);
      } else {
        points = state.mode === 'private' && line.points !== null ? line.points
          : defaultPoints(position, state.mode, state.privateLevel);
        if (points === null) throw new Error(state.mode === 'social'
          ? 'Keine UV/MV/IV-Taxpunkte hinterlegt. Nicht als 0 CHF gerechnet.' : 'Kein PP-Rahmen hinterlegt.');
        const p = fixed(points);
        if (state.mode === 'private' && (position.privateMin == null || position.privateMax == null
            || p < fixed(position.privateMin) || p > fixed(position.privateMax))) throw new Error('Taxpunkte ausserhalb des PP-Rahmens.');
        amountCents = moneyCents(points, state.taxPointValue, line.quantity);
        pointsTotal += p * BigInt(line.quantity);
      }
      total += BigInt(amountCents);
    } catch (error) { errors.push(error.message); }
    return { ...line, overridePoints: line.points, position, points, amountCHF, amountCents, errors };
  });
  const selected = new Set(lines.map(l => l.code));
  const warnings = [];
  const pairs = new Set();
  for (const line of lines) {
    for (const code of line.position?.excludes || []) {
      if (!selected.has(code) || code === line.code) continue;
      const key = [line.code, code].sort().join('|');
      if (!pairs.has(key)) {
        pairs.add(key);
        warnings.push(`${line.code} und ${code}: laut Original nicht kumulierbar. Geltungsbereich und Sitzung prüfen.`);
      }
    }
    if (line.position?.kind === 'package') {
      for (const member of line.position.members || []) {
        if (selected.has(member)) warnings.push(`${member} ist im Paket ${line.code} enthalten. Mögliche Doppelverrechnung prüfen.`);
      }
    }
  }
  return { lines, totalCents: number(total), pointsTotal: decimal(pointsTotal),
    complete: !settingsErrors.length && lines.every(line => !line.errors.length), settingsErrors, warnings };
}

export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function planCSV(state, result, version) {
  if (!result.complete) throw new Error('Bitte zuerst ungültige Positionen korrigieren.');
  const rows = [ ['Zusammenstellung', state.plan.title], ['Katalogstand', version],
    ['Tarifart', state.mode === 'private' ? 'Privatpatienten' : 'UV/MV/IV'], ['CHF pro TP', state.taxPointValue],
    ['Rundung', 'Je Position auf 0.01 CHF, kaufmännisch; keine 5-Rappen-Rundung'], [],
    ['Ziffer', 'Leistung (Original)', 'Anzahl', 'TP je Einheit', 'CHF fix je Einheit', 'CHF', 'Notiz'],
    ...result.lines.map(l => [l.code, l.position.title, l.quantity, l.points ?? '', l.amountCHF ?? '', decimal(l.amountCents), l.note]),
    [], ['Gesamtsumme CHF', decimal(result.totalCents)],
    ...result.warnings.map(w => ['Prüfhinweis', w]),
    ['Hinweis', 'Rechenhilfe, keine geprüfte Abrechnung. Material/Labor/MwSt nur soweit in Positionen enthalten.'] ];
  return '\ufeff' + rows.map(row => row.map(csvCell).join(';')).join('\r\n');
}
