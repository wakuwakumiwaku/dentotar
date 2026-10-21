# DENTOTAR Browser

Ein kompakter, lokaler Browser für Schweizer Zahnarzttarife: Positionen finden, Originalregeln nachlesen und eine persönliche Kostenzusammenstellung berechnen. Deutschsprachig, ohne Benutzerkonto, Backend-Datenbank, externe Schriftarten oder Laufzeitpakete.

## Online nutzen

Live: https://wakuwakumiwaku.github.io/dentotar/

Der Tarifkatalog mit 642 Positionen wird automatisch geladen. Keine Anmeldung, kein Datei-Upload und keine manuelle Katalogauswahl erforderlich. Originalregeln, Suche, Kostenzusammenstellung und die zugehörigen PDF-Seiten sind direkt verfügbar.

Der Katalog und die beiden Original-PDFs liegen versioniert unter `public/data/`. Zusammenstellungen, Favoriten und persönliche Notizen bleiben ausschliesslich im Browser. Nach einem Neuladen wird der Katalog automatisch erneut geladen; vorhandene Pläne bleiben erhalten. Der Speicher der Online-Seite ist vom lokalen Browser getrennt: Pläne bei Bedarf als JSON exportieren und über „Importieren“ übernehmen. Keine Patientendaten eintragen.

Falls der automatische Abruf vorübergehend fehlschlägt, bleibt die lokale Katalogdatei-Auswahl als Ersatzweg verfügbar.

## Start

Für den lokalen Start reicht Node.js ab 22; Katalog und PDFs sind bereits enthalten. Nur zur erneuten Erzeugung der Daten werden Python ab 3.10, 7-Zip (`7z`) und Poppler (`pdftotext`) benötigt. Der Import verwendet ausschliesslich die Python-Standardbibliothek.

```sh
npm start
```

Anschliessend http://127.0.0.1:5173 öffnen. Bereits importierte Daten müssen nicht erneut heruntergeladen werden. Unter Windows kann nach dem einmaligen Datenimport auch `Start DENTOTAR.cmd` verwendet werden; dafür muss Node.js im Windows-PATH stehen. Den Server beenden: Strg+C im zugehörigen Terminal.

Unter Ubuntu lassen sich die Import-Werkzeuge mit `sudo apt install p7zip-full poppler-utils` installieren. Die eigentliche Anwendung benötigt kein `npm install`. `npm ci` installiert bei dieser Version ebenfalls keine Fremdpakete.

## Bedienung

- Suche nach Ziffer, Kurztext, Originaltitel oder einem Stichwort aus den Leistungsregeln; `/` fokussiert die Suche.
- Kapitel und Favoriten grenzen den vollständigen Katalog ein. Weitere Treffer werden in Schritten von 50 geladen, nicht abgeschnitten.
- Eine Position öffnet Originaltext, Deckung, PP-Spanne, Paketbezüge und die zugehörige PDF-Seite.
- Mit `+` Positionen zusammenstellen; Anzahl, persönliche Notiz und private Taxpunkte anpassen. Explizite CHF-Fixbeträge sind separat gekennzeichnet und werden ohne Taxpunktwert multipliziert.
- Privatpatienten und UV/MV/IV sind getrennte Rechenarten. Die Deckung der einzelnen Position bleibt massgeblich, insbesondere bei Paketen für UV/MV ohne IV.
- Der Taxpunktwert ist ein frei wählbarer Rechenwert. Die vorbelegte 1.00 ist kein automatisch ermittelter oder verbindlicher Praxistarif.
- PP-Profil „Referenz“ verwendet UV-Taxpunkte nur innerhalb des ausgewiesenen PP-Rahmens, sonst dessen rechnerische Mitte. „Minimum“ und „Maximum“ wählen die jeweiligen Quellwerte. Manuell geänderte Zeilen bleiben von Profilwechseln unberührt; mit „Referenz/Profil verwenden“ zurücksetzen.
- Arbeitsstand und Favoriten werden im Browser gespeichert. Benannte Momentaufnahmen zusätzlich unter „Lokal speichern“ ablegen. JSON-Dateien dienen zur portablen Sicherung und Wiederherstellung; CSV und Druckansicht dienen der Übersicht. „Drucken / PDF“ öffnet den Browser-Druckdialog, in dem PDF als Ziel gewählt werden kann.

Browser-Speicher ist an die genaue Adresse gebunden. `localhost`, `127.0.0.1` und andere Ports sind verschiedene Speicherorte. Regelmässig JSON exportieren. Keine Patientendaten eintragen.

## Datenstand und Grenzen

Grundlage sind der offizielle MTK/ZMT-Katalog Tarif 222, V2.00 vom 01.01.2025, und die separat ausgewiesenen Kurztexte der SSO V25.1, März 2025.[1][3] Der volle Originaltext bleibt für Auslegung und Regeln massgeblich.[3] Unterschiedliche Quellen werden nicht stillschweigend vermischt: fehlende Sozialversicherungs-Taxpunkte bleiben unbekannt, auch wenn die Kurztexttabelle einen Zahlenwert enthält.

Die Rechenhilfe zeigt explizit extrahierte Nichtkumulationen sowie Paket/Einzelleistungs-Überschneidungen an. Sie prüft nicht sämtliche Einschränkungen, Häufigkeiten, Sitzungsbezüge, medizinischen Indikationen oder Versicherungsansprüche. Material, Labor und MwSt. werden nicht automatisch hinzugefügt. Unberechenbare Zeilen bleiben sichtbar und machen die Summe ausdrücklich unvollständig.

Rechnung: `Anzahl × Taxpunkte × CHF pro Taxpunkt`. Intern mit Ganzzahlen und dezimalen Eingaben; kaufmännische Rundung jeder gesamten Position auf 0.01 CHF, dann Addition. Keine automatische 5-Rappen-Rundung. Taxpunktwert höchstens vier Nachkommastellen, Taxpunkte höchstens zwei, Anzahl ganzzahlig 1–999.

## Herkunft und Nutzungsgrenzen

Unabhängige Nachschlage- und Rechenhilfe, kein offizielles Produkt der SSO oder MTK. DENTOTAR® ist eine Marke der SSO. Quellen, Originalversionen und bekannte Abweichungen sind in [docs/DATA.md](docs/DATA.md) dokumentiert. Die öffentliche Bereitstellung macht die Anwendung nicht zu einer geprüften Abrechnungssoftware.

Der vorhandene Katalog und die beiden zugehörigen Original-PDFs werden unverändert mit dem Repository und GitHub Pages bereitgestellt. Der Pages-Build kopiert ausschliesslich explizit erlaubte Dateien nach `dist-pages/`. Persönliche Pläne, Notizen, Exporte und der Arbeitsordner `sources/` bleiben ausserhalb der Veröffentlichung. Zum Nachvollziehen oder Aktualisieren der Daten kann `npm run data` verwendet werden; Änderungen am Datenstand sind vor einer Veröffentlichung gesondert zu prüfen.

## Entwicklung und Prüfung

```sh
npm run check
npm test
npm run build
npm run build:pages
node scripts/serve.mjs --dist --port 5174
```

`npm test` prüft Dezimalrechnung, Suche, Validierung, Import/Export, Warnungen, lokale HTTP-Sicherheitsgrenzen und den Importer mit synthetischen Testdaten. Es braucht keine Tarifdateien und kein Netzwerk.

Optionale native Browserprüfung mit Camoufox/Firefox und einem separat installierten kompatiblen `playwright-core`:

```sh
PLAYWRIGHT_MODULE=/absoluter/pfad/playwright-core/index.mjs \
CAMOUFOX_EXECUTABLE=/absoluter/pfad/camoufox \
npm run test:browser
```

Die Browserprüfung verwendet einen eigenen dynamischen lokalen Port und neue Browser-Kontexte. Persönliche Browserprofile bleiben unberührt. Sie prüft echte Downloads, native Dateiauswahl, Reload-Persistenz, Eingabefehler, Speicherausfälle, parallele Tabs und Layoutbreiten 320–1440 px. Ergebnisdateien und Screenshots liegen ausschliesslich in `.local/qa/`. Der Druckdialog wird im Test abgefangen; die echte Druckansicht wird mit Print-Medienregeln geprüft, nicht als native PDF-Datei ausgegeben.

Die Pages-Workflow-Datei erstellt und veröffentlicht nur `dist-pages/`; sie führt keinen Datenimport aus. `npm test` prüft zusätzlich mit privaten Testmarkern, dass nur die ausdrücklich vorgesehenen Katalog-/PDF-Dateien in den Build gelangen und zusätzliche private Dateien ausgeschlossen bleiben. `npm run test:pages` prüft optional mit dem oben beschriebenen Browser-Setup automatisches Laden ohne Dateiauswahl, Berechnung, bereitgestellte Original-PDFs, Reload, Downloads und 320–1440-px-Layouts unter dem Pages-Unterpfad. Fehler beim Laden und die native Ersatz-Dateiauswahl werden zusätzlich geprüft. Persönliche Eingaben werden nicht hochgeladen.

Architektur und Pflege: [docs/CODEBASE.md](docs/CODEBASE.md).

## Sources

[1] https://www.mtk-ctm.ch/tarife/zahnarzt
[3] https://www.sso.ch/de/Abrechnung-Dentotar
