import { buildSearchIndex, search, defaultPoints, fixedAmount, createState, validateState, calculatePlan,
  exportPlan, importPlan, planCSV, moneyCents, LIMITS } from './domain.js';
import { parseCatalog, validateCatalog, safeSourceURL, MAX_CATALOG_BYTES } from './catalog.js';

const $ = selector => document.querySelector(selector);
const h = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const amountFormat = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pointsFormat = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 2 });
const chf = cents => amountFormat.format(cents / 100);
const tp = value => value == null ? '—' : pointsFormat.format(Number(value));
const STORAGE_KEY = 'dentotar.workspace.v1';
let state = createState(), catalog, index, lookup, chapterLookup, sectionLookup, result, chapter = '', onlyFavorites = false, visible = 50;
let storageLocked = false, protectedRaw = null, storageRaw = null, toastTimer;
let catalogIsFile = false, catalogRead = 0, planRead = 0;

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3800);
}

function storageWarning(message, raw = null) {
  storageLocked = true;
  protectedRaw = raw;
  const box = $('#storage-warning');
  box.hidden = false;
  box.innerHTML = `${icon('info')}<span>${h(message)}</span>${raw !== null ? '<button id="raw-backup" class="secondary-button">Unveränderte Rohdaten sichern</button>' : ''}<button id="reload-page" class="quiet-button">Neu laden</button>`;
  $('#raw-backup')?.addEventListener('click', () => download('dentotar-rohdaten.txt', protectedRaw, 'text/plain'));
  $('#reload-page').addEventListener('click', () => location.reload());
}

function hydrate() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    storageRaw = raw;
    if (raw !== null) state = validateState(JSON.parse(raw));
  } catch {
    storageWarning('Lokaler Speicher nicht lesbar. Vorhandene Daten werden nicht überschrieben; Änderungen bleiben nur im Arbeitsspeicher.', raw ?? null);
  }
}

function persist(candidate = state) {
  if (storageLocked) {
    $('#save-status').textContent = 'Nicht gespeichert. JSON-Export zur Sicherung verwenden.';
    return false;
  }
  let valid;
  try { valid = validateState(candidate); }
  catch { $('#save-status').textContent = 'Ungültige Eingaben werden nicht gespeichert.'; return false; }
  try {
    const raw = JSON.stringify(valid);
    if (localStorage.getItem(STORAGE_KEY) !== storageRaw) {
      storageWarning('Eine andere Registerkarte hat den Speicher geändert. Automatisches Speichern pausiert. Vor dem Weiterarbeiten neu laden oder den aktuellen Plan als JSON sichern.');
      $('#save-status').textContent = 'Speichern pausiert · andere Registerkarte';
      return false;
    }
    localStorage.setItem(STORAGE_KEY, raw);
    storageRaw = raw;
    $('#save-status').textContent = 'Automatisch in diesem Browser gespeichert';
    return true;
  } catch {
    storageWarning('Speichern fehlgeschlagen. Bestehende Daten bleiben erhalten. Bitte Zusammenstellung als JSON exportieren.');
    $('#save-status').textContent = 'Speichern fehlgeschlagen';
    return false;
  }
}

function download(name, content, type) {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
const filename = extension => `dentotar-${(state.plan.title || 'zusammenstellung').replace(/[^a-zA-Z0-9äöüÄÖÜ_-]+/g, '-').slice(0, 70)}.${extension}`;

function renderNavigation() {
  const counts = new Map();
  for (const row of catalog.positions) counts.set(row.chapter, (counts.get(row.chapter) || 0) + 1);
  const chapters = catalog.chapters.filter(c => counts.has(c.id));
  $('#chapter-nav').innerHTML = `<button data-chapter="" class="chapter-button ${chapter === '' ? 'active' : ''}" ${chapter === '' ? 'aria-current="true"' : ''}><span class="chapter-number">${icon('list')}</span><span>Alle Kapitel</span><span class="chapter-count">${catalog.positions.length}</span></button>`
    + chapters.map(c => `<button data-chapter="${h(c.id)}" class="chapter-button ${chapter === c.id ? 'active' : ''}" ${chapter === c.id ? 'aria-current="true"' : ''}><span class="chapter-number">${h(c.id)}</span><span>${h(c.title)}</span><span class="chapter-count">${counts.get(c.id)}</span></button>`).join('');
  $('#chapter-select').innerHTML = '<option value="">Alle Kapitel</option>' + chapters.map(c => `<option value="${h(c.id)}">${h(c.id)} · ${h(c.title)} (${counts.get(c.id)})</option>`).join('');
  $('#chapter-select').value = chapter;
  $('#sidebar-count').textContent = catalog.positions.length;
}

function renderCatalog() {
  if (!catalog) return;
  const start = performance.now();
  const favorites = new Set(state.favorites);
  const rows = search(index, $('#search').value, { chapter, favorites: onlyFavorites ? favorites : null });
  $('#results-count').textContent = `${rows.length} ${rows.length === 1 ? 'Treffer' : 'Treffer'}`;
  $('#favorites-count').textContent = state.favorites.length;
  $('#all-filter').classList.toggle('active', !onlyFavorites);
  $('#all-filter').setAttribute('aria-pressed', String(!onlyFavorites));
  $('#favorites-filter').classList.toggle('active', onlyFavorites);
  $('#favorites-filter').setAttribute('aria-pressed', String(onlyFavorites));
  const category = chapterLookup.get(chapter);
  $('#current-filter').hidden = !chapter;
  $('#current-filter').innerHTML = chapter ? `<span>${h(chapter)} · ${h(category?.title)}</span><button id="reset-chapter" aria-label="Kapitelfilter entfernen">${icon('close')}</button>` : '';
  $('#reset-chapter')?.addEventListener('click', () => selectChapter(''));
  $('#results').innerHTML = rows.length ? rows.slice(0, visible).map(row => {
    const points = defaultPoints(row, state.mode, state.privateLevel);
    const amountCHF = fixedAmount(row, state.mode);
    const available = points !== null || amountCHF !== null;
    let price = '—';
    try { if (amountCHF !== null) price = `CHF ${chf(moneyCents(amountCHF, '1'))}`;
      else if (points !== null) price = `CHF ${chf(moneyCents(points, state.taxPointValue))}`; } catch { /* invalid input is visible in settings */ }
    const section = sectionLookup.get(row.section);
    const favorite = favorites.has(row.code);
    return `<article class="tariff-row" data-code="${h(row.code)}"><button class="favorite-button ${favorite ? 'is-favorite' : ''}" data-favorite="${h(row.code)}" aria-label="${h(row.code)} ${favorite ? 'aus Favoriten entfernen' : 'zu Favoriten hinzufügen'}" aria-pressed="${favorite}">${icon('star')}</button><button class="row-main" data-detail="${h(row.code)}"><span class="row-code">${h(row.code)}${row.kind === 'package' ? '<span class="kind-tag">Paket</span>' : row.kind === 'material' ? '<span class="kind-tag">Material</span>' : ''}</span><span class="row-title">${h(row.shortTitle || row.title)}</span><span class="row-subtitle">${h(section?.title || category?.title || row.section)}</span></button><div class="row-price"><span class="price-points ${points === null ? 'no-price' : ''}">${amountCHF !== null ? 'CHF-Fixbetrag' : points === null ? 'Keine TP' : `${tp(points)} <small>TP</small>`}</span><span class="price-chf">${price}</span>${state.mode === 'private' && row.privateMin !== null && row.privateMax !== null ? `<span class="price-range">${tp(row.privateMin)}–${tp(row.privateMax)} TP</span>` : state.mode === 'social' && row.coverage ? `<span class="price-range">${h(row.coverage)}</span>` : ''}</div><button class="add-button" data-add="${h(row.code)}" aria-label="${h(row.code)} hinzufügen" title="${!available ? 'Kein berechenbarer Wert für diese Tarifart. Details öffnen.' : 'Zur Zusammenstellung hinzufügen'}" ${!available ? 'disabled' : ''}>${icon('plus')}</button></article>`;
  }).join('') : `<div class="empty-results">${icon(onlyFavorites ? 'star' : 'search')}<h3>${onlyFavorites ? 'Noch keine passenden Favoriten.' : 'Keine passende Position gefunden.'}</h3><p>${onlyFavorites ? 'Markiere Positionen mit dem Stern oder ändere deine Suche.' : 'Versuche eine Ziffer wie 4.0000 oder einen kürzeren Suchbegriff.'}</p></div>`;
  $('#results').setAttribute('aria-busy', 'false');
  $('#load-more').hidden = rows.length <= visible;
  $('#load-more').textContent = `Weitere ${Math.min(50, Math.max(0, rows.length - visible))} anzeigen · ${Math.min(visible, rows.length)} von ${rows.length}`;
  $('#search-timing').textContent = `${Math.max(1, Math.round(performance.now() - start))} ms`;
  document.body.dataset.ready = 'true';
}

function selectChapter(id) { chapter = id; visible = 50; renderNavigation(); renderCatalog(); }

function addPosition(code) {
  const position = lookup.get(code);
  if (!position || (defaultPoints(position, state.mode, state.privateLevel) === null && fixedAmount(position, state.mode) === null)) return;
  const existing = state.plan.lines.find(l => l.code === code && !l.note && l.points === null);
  if (existing) {
    if (existing.quantity >= LIMITS.quantity) return toast('Maximale Anzahl erreicht.');
    existing.quantity += 1;
  } else {
    if (state.plan.lines.length >= LIMITS.lines) return toast(`Maximal ${LIMITS.lines} Positionen pro Zusammenstellung.`);
    state.plan.lines.push({ id: crypto.randomUUID(), code, quantity: 1, points: null, note: '' });
  }
  renderCalculator(); persist(); toast(`${code} hinzugefügt`);
}

function renderCalculator() {
  $('#private-mode').classList.toggle('active', state.mode === 'private');
  $('#social-mode').classList.toggle('active', state.mode === 'social');
  $('#private-mode').setAttribute('aria-pressed', String(state.mode === 'private'));
  $('#social-mode').setAttribute('aria-pressed', String(state.mode === 'social'));
  $('#level-setting').hidden = state.mode !== 'private';
  $('#private-level').value = state.privateLevel;
  $('#rate-help').textContent = state.mode === 'private'
    ? 'Rechenwert frei einstellen. Referenz = UV-Taxpunkte im PP-Rahmen, sonst Rahmenmitte. Kein verbindlicher Praxistarif.'
    : 'Rechenwert frei einstellen und mit dem anwendbaren Tarifvertrag abgleichen. Deckung und Originalregeln pro Position prüfen.';
  let rateError = '';
  try { moneyCents('0', state.taxPointValue); } catch (error) { rateError = error.message; }
  $('#rate-error').hidden = !rateError;
  $('#rate-error').textContent = rateError;
  $('#tax-point').setAttribute('aria-invalid', String(Boolean(rateError)));
  result = calculatePlan(state, lookup);
  if (rateError) result.complete = false;
  const count = state.plan.lines.length;
  $('#plan-count').textContent = count;
  $('#mobile-count').textContent = count;
  $('#plan-lines').innerHTML = count ? result.lines.map(line => {
    const row = line.position;
    const range = row?.privateMin != null && row?.privateMax != null ? `${tp(row.privateMin)}–${tp(row.privateMax)}` : 'kein Rahmen';
    return `<article class="plan-line" data-line="${h(line.id)}"><div class="line-top"><button class="line-code" data-detail="${h(line.code)}">${h(line.code)}</button><span class="line-title">${h(row?.shortTitle || row?.title || 'Unbekannte Position')}</span><button class="remove-line icon-button" data-remove="${h(line.id)}" aria-label="${h(line.code)} entfernen">${icon('close')}</button></div><div class="line-fields"><label class="qty-field">Anzahl<input type="number" min="1" max="999" step="1" value="${h(line.quantity)}" data-quantity="${h(line.id)}" aria-label="Anzahl ${h(line.code)}"></label><label class="points-field">${line.amountCHF !== null ? 'CHF je Einheit · fix' : state.mode === 'private' ? `TP · ${range}` : `TP · ${h(row?.coverage || 'keine Deckung')}`}<input type="text" inputmode="decimal" value="${h(line.amountCHF !== null ? amountFormat.format(line.amountCHF) : state.mode === 'private' && line.overridePoints !== null ? line.overridePoints : line.points ?? '')}" data-points="${h(line.id)}" aria-label="${line.amountCHF !== null ? 'CHF-Fixbetrag' : 'Taxpunkte'} ${h(line.code)}" ${state.mode === 'social' || line.amountCHF !== null ? 'readonly' : ''} ${line.errors.length ? 'aria-invalid="true"' : ''}></label><span class="line-amount">${line.amountCents === null ? '—' : `CHF ${chf(line.amountCents)}`}</span></div><input class="line-note" maxlength="1000" value="${h(line.note)}" data-note="${h(line.id)}" placeholder="Notiz, z. B. Zahn / Sitzung (optional)" aria-label="Notiz ${h(line.code)}">${line.overridePoints !== null && state.mode === 'private' ? `<button class="reset-points" data-reset-points="${h(line.id)}">Referenz/Profil verwenden</button>` : ''}${line.errors.map(error => `<p class="line-error">${h(error)}</p>`).join('')}</article>`;
  }).join('') : `<div class="empty-plan"><span class="empty-plan-icon"><svg><use href="#i-list"/></svg><span>+</span></span><h3>Hier wird es übersichtlich.</h3><p>Füge Positionen mit <span class="inline-plus">+</span> hinzu.<br>Mengen und Taxpunkte kannst du danach anpassen.</p></div>`;
  const warnings = [...result.warnings];
  if (!result.complete) warnings.unshift('Die Zusammenstellung ist unvollständig. Fehlerhafte Positionen sind nicht in der Zwischensumme enthalten.');
  $('#plan-warnings').hidden = !warnings.length;
  $('#plan-warnings').innerHTML = warnings.map(w => `<p class="plan-warning">${icon('info')}<span>${h(w)}</span></p>`).join('');
  $('#total-label').textContent = result.complete ? 'Gesamtsumme' : 'Zwischensumme · unvollständig';
  $('#total-points').textContent = `${result.pointsTotal} TP`;
  $('#total-amount').textContent = chf(result.totalCents);
  $('#csv-export').disabled = !result.complete;
}

function syncFields() { $('#tax-point').value = state.taxPointValue; $('#plan-title').value = state.plan.title; }
function setMode(mode) { state.mode = mode; renderCalculator(); renderCatalog(); persist(); }
function openDialog(id) { const dialog = $(id); if (!dialog.open) dialog.showModal(); }

function originalPDF(id, page = null) {
  const file = id === 'tariff-pdf' ? 'source-tariff.pdf' : 'source-shorttext.pdf';
  const fallback = id === 'tariff-pdf' ? 'https://www.mtk-ctm.ch/tarife/zahnarzt' : 'https://www.sso.ch/de/Abrechnung-Dentotar';
  const url = catalogIsFile ? safeSourceURL(catalog.sources.find(source => source.id === id)?.url) : `./data/${file}`;
  return `${url === '#' ? fallback : url.split('#')[0]}${page ? `#page=${page}` : ''}`;
}

function showDetail(code) {
  const row = lookup.get(code);
  if (!row) return toast('Diese Ziffer ist im aktuellen Katalog nicht vorhanden.');
  const chapterInfo = chapterLookup.get(row.chapter);
  const sectionInfo = sectionLookup.get(row.section);
  const related = (codes, label) => codes?.length ? `<div class="detail-section"><h3>${label}</h3><div class="related-codes">${codes.map(c => lookup.has(c) ? `<button class="code-link" data-detail="${h(c)}">${h(c)}</button>` : `<span>${h(c)}</span>`).join('')}</div></div>` : '';
  const points = defaultPoints(row, state.mode, state.privateLevel);
  const available = points !== null || fixedAmount(row, state.mode) !== null;
  const socialDisplay = fixedAmount(row, 'social') !== null
    ? `CHF ${chf(moneyCents(fixedAmount(row, 'social'), '1'))} fix` : `${tp(row.socialPoints)} TP`;
  const privateDisplay = fixedAmount(row, 'private') !== null
    ? `CHF ${chf(moneyCents(fixedAmount(row, 'private'), '1'))} fix`
    : row.privateMin == null || row.privateMax == null ? 'Kein Rahmen' : `${tp(row.privateMin)}–${tp(row.privateMax)} TP`;
  $('#detail-content').innerHTML = `<p class="detail-code">${h(row.code)}${row.kind === 'package' ? ' · Leistungspaket' : ''}</p><h2 id="detail-title" class="detail-title">${h(row.title)}</h2><p class="detail-subtitle">${h(row.section)} · ${h(sectionInfo?.title || chapterInfo?.title)}</p>${row.shortTitle && row.shortTitle !== row.title ? `<p class="short-title"><span>SSO-Kurztext V.25.1</span> ${h(row.shortTitle)}</p>` : ''}<div class="detail-grid"><div class="detail-stat"><span>UV / MV / IV</span><strong>${socialDisplay}</strong><small>Deckung: ${h(row.coverage || 'keine Angabe')}</small></div><div class="detail-stat"><span>Privatpatienten</span><strong>${privateDisplay}</strong></div></div><div class="detail-section"><h3>Originaltext · Tarif 222</h3><div class="original-notes">${h(row.notes || 'Keine zusätzlichen Hinweise auf der Positionsseite.')}</div></div>${sectionInfo?.notes ? `<details class="detail-section"><summary>Übergeordnete Kapitelregeln · ${h(row.section)}</summary><div class="original-notes">${h(sectionInfo.notes)}</div></details>` : ''}${chapterInfo?.notes ? `<details class="detail-section"><summary>Übergeordnete Kapitelregeln · ${h(row.chapter)}</summary><div class="original-notes">${h(chapterInfo.notes)}</div></details>` : ''}${related(row.excludes, 'Explizite Nichtkumulationen (automatisch extrahiert)')}${related(row.members, 'Im Leistungspaket enthalten')}${related(row.packages, 'Mitglied von Leistungspaketen')}<div class="detail-section"><p>Gültigkeit laut Quelle: ${h(row.validity || 'keine Angabe')}<br>MwSt.-Angabe: ${h(row.vat || 'keine Angabe')}</p></div><div class="detail-links"><a href="${h(originalPDF('tariff-pdf', row.sourcePage))}" target="_blank" rel="noopener">Original-PDF${row.sourcePage ? ` · Seite ${row.sourcePage}` : ''} ↗</a><a href="https://www.mtk-ctm.ch/tarife/zahnarzt" target="_blank" rel="noopener noreferrer">Offizielle Quelle ↗</a></div><p class="detail-caution">Abgeleitete Prüfhinweise sind nicht vollständig. Originaltext und übergeordnete Regeln sind massgeblich. Keine automatische Prüfung der medizinischen oder versicherungsrechtlichen Abrechenbarkeit.</p><div class="detail-actions"><button class="primary-button" data-add="${h(row.code)}" ${!available ? 'disabled' : ''}>${icon('plus')} Hinzufügen</button><button class="secondary-button" data-favorite="${h(row.code)}">${icon('star')} ${state.favorites.includes(row.code) ? 'Favorit entfernen' : 'Als Favorit merken'}</button></div>`;
  openDialog('#detail-dialog');
}

function renderSources() {
  const safeURL = safeSourceURL;
  if (!catalog) {
    $('#source-content').innerHTML = '<p>Der bereitgestellte Tarifkatalog wird automatisch geladen. Falls das Laden fehlschlägt, kann ersatzweise eine vorhandene <code>catalog.json</code> auf dem eigenen Gerät geöffnet werden; diese Dateiauswahl lädt nichts hoch.</p><p><a href="https://www.mtk-ctm.ch/tarife/zahnarzt" target="_blank" rel="noopener noreferrer">MTK/ZMT · offizielle Tarifquelle ↗</a></p><p><a href="https://www.sso.ch/de/Abrechnung-Dentotar" target="_blank" rel="noopener noreferrer">SSO · DENTOTAR und Nutzungsbedingungen ↗</a></p>';
    return;
  }
  $('#source-content').innerHTML = `<p>Geladener Katalog: <strong>${h(catalog.version)}</strong> · ${catalog.positions.length} kanonische Positionen. Versionsstand der Quelle, keine Zusicherung aktueller Abrechenbarkeit.</p>`
    + catalog.sources.map(source => `<article class="source-card"><h3>${h(source.title)}</h3><p>${h(source.version || '')}</p><a href="${h(safeURL(source.url))}" target="_blank" rel="noopener noreferrer">Offizielle Quelle ↗</a>${source.sha256 ? `<details><summary>SHA-256 des Originals</summary><code>${h(source.sha256)}</code></details>` : ''}</article>`).join('')
    + `<div class="source-rights"><h3>Nutzung &amp; Grenzen</h3><p>Unabhängige persönliche Nachschlage- und Rechenhilfe, kein offizielles Produkt der SSO oder MTK. DENTOTAR® ist eine geschützte Marke der SSO. Der bereitgestellte Katalog und die beiden Original-PDFs sind mit Quellen und Versionsstand im Repository dokumentiert. Diese Nachschlagehilfe ersetzt keine geprüfte Praxisabrechnung.</p><p>Die vollständigen Originaltexte bleiben massgeblich. PP-Spannen und Sozialversicherungstarif werden getrennt geführt. Kein automatischer Aufschlag für Material, Labor oder MwSt. Keine Prüfung von Leistungsanspruch, Kombinationen über Sitzungen hinweg oder sämtlichen Häufigkeitsregeln.</p><p>Pläne und Favoriten bleiben im lokalen Browser-Speicher. JSON-Exporte regelmässig separat sichern. Keine Patientendaten eintragen.</p></div>`
    + (catalog.notices || []).map(note => `<p class="source-notice">${h(note)}</p>`).join('')
    + `<p><a href="${h(originalPDF('shorttext-pdf'))}" target="_blank" rel="noopener noreferrer">SSO-Kurztext im Original ↗</a></p>`;
}

function renderSaved() {
  $('#saved-content').innerHTML = state.savedPlans.length ? state.savedPlans.map(saved => `<article class="saved-item"><h3>${h(saved.plan.title)}</h3><p>${saved.plan.lines.length} Positionen · ${h(saved.savedAt.slice(0, 16).replace('T', ' '))} UTC · ${h(saved.catalogVersion)}</p><div class="saved-item-actions"><button class="primary-button" data-load-saved="${h(saved.id)}">Öffnen</button><button class="quiet-button" data-delete-saved="${h(saved.id)}">Entfernen</button></div></article>`).join('') : '<p class="empty-saved">Noch keine Zusammenstellung benannt gespeichert. Der aktuelle Arbeitsstand wird unabhängig davon automatisch gespeichert.</p>';
}

function printPlan() {
  const result = calculatePlan(state, lookup);
  const table = result.lines.map(line => `<tr><td>${h(line.code)}</td><td>${h(line.position?.title || 'Unbekannte Position')}${line.note ? `<small>${h(line.note)}</small>` : ''}${line.errors.map(e => `<small class="print-error">${h(e)}</small>`).join('')}</td><td>${line.quantity}</td><td>${h(line.amountCHF !== null ? `CHF ${amountFormat.format(line.amountCHF)} fix` : line.points ?? '—')}</td><td>${line.amountCents === null ? '—' : chf(line.amountCents)}</td></tr>`).join('');
  $('#printout').innerHTML = `<div class="print-header"><h1>${h(state.plan.title)}</h1><p>DENTOTAR Browser · Persönliche Rechenhilfe · ${h(new Date().toLocaleDateString('de-CH'))}</p></div><p>Tarif: ${state.mode === 'private' ? 'Privatpatienten' : 'UV/MV/IV'} · CHF pro TP: ${h(state.taxPointValue)} · Katalogstand ${h(catalog.version)}</p>${!result.complete ? '<h2 class="print-error">UNVOLLSTÄNDIG · nur berechenbare Positionen in der Zwischensumme</h2>' : ''}<table><thead><tr><th>Ziffer</th><th>Leistung / Notiz</th><th>Anzahl</th><th>TP / CHF fix</th><th>CHF</th></tr></thead><tbody>${table}</tbody><tfoot><tr><th colspan="4">${result.complete ? 'Gesamtsumme' : 'Zwischensumme'} CHF</th><th>${chf(result.totalCents)}</th></tr></tfoot></table>${result.warnings.map(w => `<p>${h(w)}</p>`).join('')}<p>Je Position auf 0.01 CHF gerundet. Material, Labor und MwSt. nicht automatisch ergänzt. Originalregeln und Nutzungsrechte beachten. Keine geprüfte Abrechnung.</p><p>Quelle: Zahnarzt-Tarif UV/MV/IV V2.00, 01.01.2025, MTK/ZMT · https://www.mtk-ctm.ch/tarife/zahnarzt<br>SSO-Kurztext V25.1, März 2025 · https://www.sso.ch/de/Abrechnung-Dentotar</p>`;
  window.print();
}

function toggleFavorite(code) {
  if (state.favorites.includes(code)) state.favorites = state.favorites.filter(c => c !== code);
  else state.favorites.push(code);
  renderCatalog(); persist();
  if ($('#detail-dialog').open) showDetail(code);
}

function bindEvents() {
  $('#catalog-open').addEventListener('click', () => $('#catalog-file').click());
  $('#catalog-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    const generation = ++catalogRead;
    $('#catalog-open').disabled = true;
    $('#catalog-error').hidden = true;
    try {
      if (file.size > MAX_CATALOG_BYTES) throw new Error('Katalogdatei zu gross (maximal 20 MB).');
      const incoming = parseCatalog(await file.text());
      if (generation !== catalogRead) return;
      activateCatalog(incoming, true);
    } catch (error) {
      if (generation === catalogRead) showCatalogStart(error.message);
    } finally {
      if (generation === catalogRead) { $('#catalog-open').disabled = false; event.target.value = ''; }
    }
  });
  $('#search').addEventListener('input', () => { visible = 50; renderCatalog(); });
  $('#chapter-nav').addEventListener('click', event => { const button = event.target.closest('[data-chapter]'); if (button) selectChapter(button.dataset.chapter); });
  $('#chapter-select').addEventListener('change', event => selectChapter(event.target.value));
  $('#all-filter').addEventListener('click', () => { onlyFavorites = false; visible = 50; renderCatalog(); });
  $('#favorites-filter').addEventListener('click', () => { onlyFavorites = true; visible = 50; renderCatalog(); });
  $('#load-more').addEventListener('click', () => { visible += 50; renderCatalog(); });
  document.addEventListener('click', event => {
    const action = event.target.closest('button');
    if (!action) return;
    if (action.dataset.add) addPosition(action.dataset.add);
    else if (action.dataset.detail) showDetail(action.dataset.detail);
    else if (action.dataset.favorite) toggleFavorite(action.dataset.favorite);
    else if (action.dataset.remove) {
      state.plan.lines = state.plan.lines.filter(l => l.id !== action.dataset.remove); renderCalculator(); persist();
    } else if (action.dataset.resetPoints) {
      state.plan.lines.find(l => l.id === action.dataset.resetPoints).points = null; renderCalculator(); persist();
    }
  });
  $('#plan-lines').addEventListener('change', event => {
    const target = event.target;
    const id = target.dataset.quantity || target.dataset.points;
    if (!id) return;
    const line = state.plan.lines.find(l => l.id === id);
    if (!line) return;
    if (target.dataset.quantity) line.quantity = Number(target.value);
    else if (state.mode === 'private') line.points = target.value;
    renderCalculator(); persist();
  });
  $('#plan-lines').addEventListener('input', event => {
    const id = event.target.dataset.note;
    if (!id) return;
    state.plan.lines.find(l => l.id === id).note = event.target.value; persist();
  });
  $('#plan-title').addEventListener('input', event => { state.plan.title = event.target.value; persist(); });
  $('#tax-point').addEventListener('input', event => { state.taxPointValue = event.target.value; renderCalculator(); renderCatalog(); persist(); });
  $('#private-level').addEventListener('change', event => { state.privateLevel = event.target.value; renderCalculator(); renderCatalog(); persist(); });
  $('#private-mode').addEventListener('click', () => setMode('private'));
  $('#social-mode').addEventListener('click', () => setMode('social'));
  $('#clear-plan').addEventListener('click', () => {
    if (!state.plan.lines.length || !confirm('Die aktuelle Zusammenstellung leeren? Benannt gespeicherte Pläne bleiben erhalten.')) return;
    state.plan = { title: 'Neue Zusammenstellung', lines: [] }; syncFields(); renderCalculator(); persist();
  });
  $('#sources-button').addEventListener('click', () => { renderSources(); openDialog('#sources-dialog'); });
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    } });
  }
  $('#save-plan').addEventListener('click', () => {
    try {
      validateState(state);
      if (state.savedPlans.length >= LIMITS.savedPlans) throw new Error(`Maximal ${LIMITS.savedPlans} gespeicherte Pläne. Vorher einen exportieren und entfernen.`);
      const saved = { id: crypto.randomUUID(), savedAt: new Date().toISOString(), catalogVersion: catalog.version,
        mode: state.mode, privateLevel: state.privateLevel, taxPointValue: state.taxPointValue, plan: structuredClone(state.plan) };
      const candidate = { ...state, savedPlans: [...state.savedPlans, saved] };
      if (persist(candidate)) { state = candidate; toast('Zusammenstellung lokal gespeichert.'); }
      else toast('Zusammenstellung nicht lokal gespeichert. Aktuellen Plan bitte als JSON sichern.');
    } catch (error) { toast(error.message); }
  });
  $('#saved-button').addEventListener('click', () => { renderSaved(); openDialog('#saved-dialog'); });
  $('#saved-content').addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.loadSaved) {
      const saved = state.savedPlans.find(p => p.id === button.dataset.loadSaved);
      if (!saved || (state.plan.lines.length && !confirm('Aktuellen Arbeitsstand durch den gespeicherten Plan ersetzen? Vorher bei Bedarf als JSON sichern.'))) return;
      state.plan = structuredClone(saved.plan); state.mode = saved.mode; state.privateLevel = saved.privateLevel; state.taxPointValue = saved.taxPointValue;
      syncFields(); renderCalculator(); renderCatalog(); persist(); $('#saved-dialog').close();
      if (saved.catalogVersion !== catalog.version) toast('Anderer Katalogstand. Werte und Originalregeln bitte prüfen.');
    } else if (button.dataset.deleteSaved && confirm('Diesen benannt gespeicherten Plan entfernen?')) {
      state.savedPlans = state.savedPlans.filter(p => p.id !== button.dataset.deleteSaved); persist(); renderSaved();
    }
  });
  $('#json-export').addEventListener('click', () => { try { download(filename('json'), JSON.stringify(exportPlan(state, catalog.version), null, 2), 'application/json'); } catch (e) { toast(e.message); } });
  $('#csv-export').addEventListener('click', () => { try { download(filename('csv'), planCSV(state, calculatePlan(state, lookup), catalog.version), 'text/csv'); } catch (e) { toast(e.message); } });
  $('#print-plan').addEventListener('click', printPlan);
  $('#import-button').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    const generation = ++planRead;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Datei zu gross (maximal 2 MB).');
      const text = await file.text();
      if (generation !== planRead) return;
      const incoming = importPlan(JSON.parse(text), catalog.version);
      if (state.plan.lines.length && !confirm('Datei geprüft. Aktuelle Zusammenstellung durch den Import ersetzen?')) return;
      state.plan = incoming.plan; state.mode = incoming.mode; state.privateLevel = incoming.privateLevel; state.taxPointValue = incoming.taxPointValue;
      syncFields(); renderCalculator(); renderCatalog(); const saved = persist();
      toast(incoming.versionMismatch ? 'Importierter Katalogstand weicht ab. Werte bitte prüfen.' : saved ? 'Zusammenstellung importiert und lokal gespeichert.' : 'Import nur im Arbeitsspeicher. Bitte als JSON sichern.');
    } catch (error) { if (generation === planRead) toast(`Import abgelehnt: ${error.message}`); }
    finally { if (generation === planRead) event.target.value = ''; }
  });
  for (const view of ['catalog', 'plan']) $(`#${view}-tab`).addEventListener('click', () => {
    document.body.dataset.view = view;
    for (const name of ['catalog', 'plan']) {
      $(`#${name}-tab`).classList.toggle('active', name === view);
      $(`#${name}-tab`).setAttribute('aria-pressed', String(name === view));
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  document.addEventListener('keydown', event => {
    if (catalog && event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !document.querySelector('dialog[open]')
      && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !document.activeElement.isContentEditable) {
      event.preventDefault(); $('#catalog-tab').click(); $('#search').focus();
    }
  });
  window.addEventListener('storage', event => {
    if ((event.key === STORAGE_KEY || event.key === null) && event.storageArea === localStorage) {
      storageWarning('Eine andere Registerkarte hat den Speicher geändert. Automatisches Speichern pausiert. Vor dem Weiterarbeiten neu laden oder den aktuellen Plan als JSON sichern.');
      $('#save-status').textContent = 'Speichern pausiert · andere Registerkarte';
    }
  });
}

function showCatalogStart(message = '') {
  $('#catalog-start').hidden = false;
  $('#workspace').hidden = true;
  $('.mobile-tabs').hidden = true;
  $('#catalog-error').textContent = message;
  $('#catalog-error').hidden = !message;
  document.body.dataset.ready = 'waiting';
}

function activateCatalog(incoming, fromFile = false) {
  const next = validateCatalog(incoming);
  const nextIndex = buildSearchIndex(next.positions);
  const nextLookup = new Map(next.positions.map(position => [position.code, position]));
  const nextChapters = new Map(next.chapters.map(item => [item.id, item]));
  const nextSections = new Map(next.sections.map(item => [item.id, item]));
  catalog = next; index = nextIndex; lookup = nextLookup; catalogIsFile = fromFile;
  chapterLookup = nextChapters; sectionLookup = nextSections;
  $('#catalog-version').textContent = `Katalogstand ${catalog.version}`;
  $('#catalog-total').textContent = `${catalog.positions.length} Positionen`;
  $('#catalog-start').hidden = true;
  $('#workspace').hidden = false;
  $('.mobile-tabs').hidden = false;
  syncFields(); renderNavigation(); renderCalculator(); renderCatalog();
  if (storageLocked) $('#save-status').textContent = 'Automatisches Speichern pausiert';
}

async function boot() {
  hydrate(); bindEvents();
  document.body.dataset.view = 'catalog';
  if (document.querySelector('meta[name="dentotar-catalog"]')?.content === 'local-file') {
    showCatalogStart();
    return;
  }
  const response = await fetch('./data/catalog.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error('Lokaler Katalog fehlt. „npm run data“ im Projekt ausführen oder eine vorhandene catalog.json öffnen.');
  activateCatalog(await response.json());
}

boot().catch(error => showCatalogStart(error.message));
