# Codebase-Leitfaden

## Aufbau

- `index.html`: zugängliche deutsche Oberfläche, SVG-Icons, Formular- und Dialogstruktur.
- `src/styles.css`: dunkles violettes Farbthema mit anthrazitfarbenem Hintergrund, abgestuften dunklen Karten und heller Schrift; zentrale semantische Farbtokens und kontrastreiche native Dropdowns; responsives Drei-Spalten-Layout, Mobilansichten und neutrale Druckregeln. Warnungen bleiben gelb und Fehler rot auf dunklen Hinweisflächen. Leseschrift: Tariftitel und Formulare 17 px, Originaltexte 16 px, Beträge 15–18 px; größere Zeilenabstände, helle Sekundärtexte und deutliche Feldumrandungen. Bei kleineren Breiten werden Spalten und Aktionen umgebrochen statt die Schrift stark zu verkleinern. Noch stärkerer Kontrast: nahezu schwarzer Hintergrund, weisse Primärtexte, sehr helle Sekundärtexte und klar abgesetzte Feld- und Kartengrenzen. Die Druckansicht bleibt unverändert hell; Darstellung ändert weder Tarifdaten noch Browser-Speicherschlüssel.
- `src/catalog.js`: begrenzter JSON-Katalogparser mit vollständiger Prüfung der im UI verwendeten Felder vor Aktivierung; HTTPS-Quelllinks und optionale SHA-256-Angaben als exakt 64-stellige Hex-Zeichenfolge; fehlerhafte Metadaten vor jeder Aktivierung ablehnen.
- `scripts/build-pages.mjs`: öffentlicher Build aus explizit erlaubten Code-/Assetdateien sowie `public/data/catalog.json` und den beiden Original-PDFs; niemals `public/` oder den vollständigen `dist/` pauschal kopieren. Prüft den Katalog mit demselben Parser wie die App, bevor ein vorhandener Build ersetzt wird; unlesbare oder schemawidrige Kataloge brechen den Build ab. `.github/workflows/pages.yml` veröffentlicht ausschliesslich `dist-pages/`.
- `tests/pages.test.mjs`, `tests/pages-browser.mjs`: private Canary-Dateien gegen versehentliches Publishing, Katalogvalidierung und native Pages-Prüfung unter `/dentotar/`, einschliesslich nativer Dateieingabe, Fehlversuchen, Downloads und Reload.
- `src/app.js`: Suche/Rendering, Dialoge, lokale Speicherung, benannte Pläne, native Datei-Downloads, Import und Druckansicht. Tarif- und Benutzereingaben werden als Text gerendert, nie als ungeprüftes HTML.
- `src/domain.js`: reine Funktionen für Suchindex, PP-/Sozialtarif-Auswahl, exakte Dezimalrechnung, Planvalidierung, Warnungen und portable Formate.
- `scripts/acquire_sources.py`: direkte HTTPS-Downloads der offiziellen Originale; Formaterkennung und SHA-256-Provenienz. Keine Zugangsdaten.
- `scripts/import_catalog.py`: CHM/PDF-Import und Quellabgleich; Details in DATA.md.
- `scripts/serve.mjs`: lokaler statischer Server, feste Routen-Whitelist, Loopback-/Host-Grenze, CSP, ETags und ausgehandeltes Gzip. Keine Schreib-API. Verhindert auch Zugriff über Symlinks ausserhalb des freigegebenen Roots.
- `scripts/build.mjs`: erzeugt einen eigenständigen statischen lokalen Build in `dist/`. Bricht bei fehlendem Katalog ab.
- `tests/domain.test.mjs`, `tests/server.test.mjs`, `tests/test_import_catalog.py`: netzwerkfreie Regressionstests mit synthetischen Daten.
- `tests/browser.mjs`: optionale native Headless-Camoufox-Prüfung am tatsächlich importierten Katalog. Alle Kontexte und der Testserver werden geschlossen.
- `.github/workflows/ci.yml`: Syntax- und netzwerkfreie Funktionstests unter Node 22/Python 3.12; kein Deployment.

Keine Frontend-Laufzeitabhängigkeiten, keine Telemetrie, kein externer Font, keine Datenbank. Für die reale Datenübernahme werden `7z` und `pdftotext` benötigt. Der veröffentlichte Katalog und die beiden PDFs sind versioniert; Rohdownloads, zusätzliche Datendateien und persönliche Exporte bleiben ignoriert. Der Code enthält keine Praxis-/Patientendaten.

## Datenverträge

Katalog: `schemaVersion: 1`; Quellversionen getrennt von Abrufzeit halten. Eindeutige kanonische `code`-Werte, Kapitel, Unterkapitel, Originaltext, optionale Kurztexte und Herkunft bis zur PDF-Seite. `null` ist ein fehlender Wert, niemals null CHF. AL-Platzhalter sind keine zusätzlichen abrechenbaren Positionen.

Arbeitsstand: localStorage-Schlüssel `dentotar.workspace.v1` mit `schemaVersion: 1`, globaler Tarifart, CHF/TP, PP-Profil, aktuellem Plan, Favoriten und benannten Plan-Momentaufnahmen. Zeilen enthalten eindeutige ID, wörtliche Tarifziffer, ganzzahlige Anzahl, nullable privaten TP-Override und Notiz. Ein `null`-Override folgt dem PP-Profil; Sozialtarif ignoriert private Overrides, ohne sie zu löschen.

Portabler Export: `kind: dentotar-plan`, Schema, Katalogversion, Tarifart, TPW, PP-Profil und Plan. Import zuerst vollständig validieren, danach gegebenenfalls Ersatz bestätigen. Unbekannte Ziffern bleiben als ungültige Zeilen sichtbar. Katalog- und Planimporte verwenden getrennte Eingaben und werden vor Aktivierung validiert. CSV schützt textuelle Zellen vor Formelinjektion.

## Verlässlichkeit

- Geld in Rappen mit BigInt-Zwischenschritten rechnen. Nicht mit binären Float-Beträgen summieren.
- Explizite CHF-Fixbeträge aus `amountsCHF` direkt mit der Anzahl multiplizieren, nie mit dem Taxpunktwert. Im Formular, Export und Druck von Taxpunkten unterscheiden; offene CHF-Ausdrücke bleiben unberechenbar.
- Fehlende Werte und echte 0-TP-Positionen getrennt halten.
- UV/MV/IV-Punkte nie aus PP-Spannen oder widersprüchlichen Kurztext-Spalten ergänzen.
- Nichtkumulationen und Paketüberschneidungen sind abgeleitete Hinweise, keine vollständige Abrechnungsprüfung.
- Bei unlesbarem Speicher keine automatische Ersetzung durchführen. Original-Rohstring unverändert zum Download anbieten; Speicherung bleibt gesperrt.
- Bei Schreibfehlern ist die Rechenansicht weiter benutzbar; Speicherstatus und Exportmöglichkeit bleiben ehrlich.
- Ein externer `storage`-Event pausiert eigene weitere Schreibvorgänge bis zum Neuladen. Keine behauptete Transaktion oder automatische Konfliktauflösung zwischen Tabs.
- Ungültige Zwischen-Eingaben nicht speichern und nicht als vollständige Gesamtsumme präsentieren.
- CSV und Druck bei ihrer Auslösung aus dem aktuellen Arbeitsstand berechnen, statt einen älteren Render-Snapshot zu exportieren. Direkt geänderte, ersetzte und geleerte Zeilennotizen ohne zwischenzeitlichen Reload/Rechenfeldwechsel nativ prüfen.
- Pläne und Favoriten sind keine dauerhafte Datensicherung; JSON exportieren. Adresse/Port bei normaler Nutzung beibehalten.

## Pflegeablauf

1. Quellen und Schemaänderungen bewusst prüfen; keine Tarifwerte von Hand erfinden oder stillschweigend überschreiben.
2. Diesen Leitfaden und relevante Datenhinweise bei funktionalen Änderungen aktualisieren.
3. `npm run check` und `npm test` ausführen; bei UI-/Persistenzänderungen zusätzlich native Browserprüfung.
4. Desktop, Tablet, 390 und 320 px prüfen; echte Listenzeilen, Details und das Ende der Zusammenstellung anschauen.
5. Vor jedem Commit ignorierte Quelldateien, lokale Daten und vollständigen Staging-Diff kontrollieren.
6. Nur die dokumentierten Katalog-/Originaldateien veröffentlichen; niemals persönliche Pläne oder beliebige zusätzliche Datendateien übernehmen.

## Öffentliche Pages-Version

Der Pages-Build markiert den Einstieg mit `meta[name="dentotar-catalog"][content="hosted"]` und erlaubt mit `connect-src 'self'` den Abruf des bereitgestellten Katalogs vom eigenen Host. Die App lädt `./data/catalog.json` automatisch, validiert sie und aktiviert dieselbe Suche/Rechenoberfläche wie lokal. Keine Dateiauswahl ist erforderlich, auch nicht nach einem Reload. PDF-Links führen zu den mitgelieferten Originalen unter `./data/` und behalten ihre Seitenfragmente. Der Build enthält ausschliesslich die explizite Datei-Allowlist inklusive der drei freigegebenen Datendateien. Zusätzliche private Dateien unter `public/` werden nicht übernommen.

Arbeitsstand, Favoriten und benannte Pläne bleiben im lokalen Browser-Speicher; es gibt keine Schreib-/Upload-API. Falls der automatische Katalogabruf scheitert, kann eine lokale Ersatzdatei mit demselben strikten Parser geöffnet werden. Eine solche Ersatzdatei bleibt im Arbeitsspeicher; nach dem Reload wird wieder der bereitgestellte Katalog automatisch geladen, ohne den gespeicherten Arbeitsstand zurückzusetzen.
