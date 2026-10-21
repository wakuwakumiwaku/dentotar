# Lokale Tarifdaten und Herkunft

## Rechte und Zweck

Dieses Projekt ist eine unabhängige Nachschlage- und Rechenhilfe, keine geprüfte Praxis- oder Abrechnungssoftware und kein offizielles Angebot von SSO oder ZMT. DENTOTAR® ist eine Marke der SSO. Herausgeber, Originalversionen und Abweichungen bleiben sichtbar dokumentiert.

`public/data/catalog.json`, `public/data/source-tariff.pdf` und `public/data/source-shorttext.pdf` sind die ausdrücklich veröffentlichten Dateien. Katalog und Original-PDFs werden auf GitHub Pages direkt bereitgestellt und automatisch geladen. Die PDFs bleiben unveränderte Kopien; ihre SHA-256-Prüfsummen stehen in `catalog.sources`. Der lokale Rohdownload-Ordner `sources/`, zusätzliche Datendateien und persönliche Pläne werden nicht veröffentlicht.

## Quellen und Vorrang

- **MTK/ZMT, Tarif 222:** `sso-uv-mv-iv-2025.chm` und `sso-uv-mv-iv-2025.pdf`; V2.00 vom 01.01.2025, Bearbeitungsstand 18.12.2024. [Offizielle Bezugsseite](https://www.mtk-ctm.ch/tarife/zahnarzt).
- **SSO, DENTOTAR®-Kurztext:** `dentotar-kurztext.pdf`; Version 25.1, Stand März 2025. [Originaldownload](https://www.sso.ch/de/media/4457/download?attachment).
- Download-URLs, Dateigrößen und SHA-256 stehen in `sources/downloads.json`; der Import prüft alle drei Originaldateien gegen dieses Manifest und übernimmt ihre Provenienz in `catalog.sources`.

**CHM-Volltext und CHM-Werte bleiben maßgeblich.** `title` ist die vollständige CHM-Bezeichnung; `shortTitle` ist ausschließlich der separat bezeichnete SSO-Kurztext. Kurztextwerte überschreiben niemals CHM-Werte. Die gemeinsame Katalogversion `2025.1` ersetzt nicht die unterschiedlichen Originalversionsangaben.

## Reproduzieren

Voraussetzungen: Python 3 (nur Standardbibliothek), `7z` und `pdftotext`; die drei Originaldateien und das Downloadmanifest müssen unter `sources/` vorliegen.

```sh
python3 scripts/import_catalog.py
python3 -m unittest discover -s tests -p test_import_catalog.py -v
```

Der Import benötigt kein Netzwerk und ist nicht vom aktuellen Arbeitsverzeichnis abhängig. Er entpackt **bei jedem Lauf das geprüfte CHM neu** im temporären Cache und extrahiert PDF-Text erneut im Speicher. Bereits vorhandene HTML-/TXT-Auszüge werden nicht als Quelle vertraut; Originaldateien bleiben unverändert. Fehlende Dateien, Prüfsummenabweichungen, unbekannte Metadaten und doppelte kanonische Codes führen zum Abbruch. Identische Eingaben und Werkzeuge liefern identisches JSON ohne Zeitstempel.

Erzeugt werden ausschließlich:

- `public/data/catalog.json`
- `public/data/source-tariff.pdf` – unveränderte Kopie des Volltext-PDFs
- `public/data/source-shorttext.pdf` – unveränderte Kopie der Kurztext-Ausgabe

## Verifizierter Umfang der vorliegenden Originale

| Merkmal | Anzahl |
| --- | ---: |
| HTML-Seiten unter Tarif 222 | 812 |
| Kanonische Positionen | 642 |
| Separat erfasste AL-Aliasse, nicht als Position gezählt | 44 |
| Kapitel / Abschnitte einschließlich Unterabschnitten | 16 / 109 |
| Leistungen / Pakete / Material / Clusterreferenzen | 578 / 44 / 17 / 3 |
| Numerische Sozial-Taxpunktwerte / Privatpunktbereiche | 597 / 578 |
| Feste CHF-Beträge, separat von Taxpunkten | 9 |
| Positionen mit Detailnotizen | 489 |
| Kapitel / Abschnitte mit eigenen Interpretationsnotizen | 5 / 38 |
| Explizite gerichtete Nichtkumulationsbeziehungen | 128 |
| Paketbestandteile / umgekehrte Paketmitgliedschaften | 183 / 183 |
| Verifizierte Volltext-PDF-Seitenzuordnungen | 642 von 642 |
| Kurztexte, durch unabhängigen Layoutscan bestätigt | 641 |
| Numerisch verglichene Kurztextzeilen / Einzelvergleiche | 630 / 1.881 |
| Abweichende Felder / betroffene Positionen | 121 / 76 |
| Nicht auflösbare Positions-/Kapitel-/Paketreferenzen | 0 |

Das Volltext-PDF hat 206, die Kurztext-Ausgabe 24 Seiten. `sourcePage` zählt die PDF-Seiten ab 1, nicht bloße Codefundstellen: Nur ein führender Positionskopf mit nachfolgendem Gültigkeitsblock und passender CHM-Bezeichnung wird zugeordnet. Umbrüche nach `/` werden ausschließlich für diesen Vergleich normalisiert; ungesicherte Zuordnungen wären `null`.

## Bekannte Quellenabweichungen

Der vollständige maschinenlesbare Abgleich steht unter `shorttextComparison.mismatches`, mit Code, Feld, CHM-Wert, Kurztextwert und Kurztextseite.

- **25 Sozialwerte** sind im CHM nicht angegeben, im Kurztext jedoch numerisch. Sie bleiben `null`. Darunter **4.0300**: Kurztext 13.9; laut MTK seit 2024 nicht zu Lasten UV/MV/IV verrechenbar. Auch andere fehlende Sozialwerte werden nicht ergänzt; aus einem fehlenden Wert wird keine allgemeine Deckungsaussage abgeleitet.
- **44 Leistungspakete** enthalten im Kurztext Privat-Minimum und -Maximum 0, im CHM aber keine Privatwerte: **88 Feldabweichungen**, CHM-Werte bleiben `null`.
- **8 echte numerische Privatpunktabweichungen**, jeweils CHM → Kurztext:

| Code | Feld | CHM | Kurztext |
| --- | --- | ---: | ---: |
| 4.2360 | Minimum | 340.8 | 340.9 |
| 4.2520 | Maximum | 757.8 | 757.9 |
| 4.2540 | Minimum | 340.8 | 340.9 |
| 4.3220 | Maximum | 601.4 | 601.5 |
| 4.5730 | Minimum | 651.9 | 652.0 |
| 4.5770 | Maximum | 601.4 | 601.5 |
| 4.5790 | Maximum | 601.4 | 601.5 |
| 4.8960 | Minimum | 340.8 | 340.9 |

- **4.2600 fehlt vollständig im Kurztext**, bleibt aber als CHM-Position mit `shortTitle: null` erhalten. Das ist die einzige Importwarnung; keine Referenz ist unaufgelöst.
- `D.yyyy` nennt im CHM-Titel 2.6 % MWST, in der Metadatenzeile jedoch „Normalsatz“. Beide Originalangaben bleiben erhalten; keine automatische steuerliche Korrektur.
- Bei `4.8250.M` steht in der Kurztext-Ausgabe „CH 127.00“ statt „CHF“. Der CHF-Zeilentyp wird erkannt, ohne die Quelldatei zu verändern; sämtliche neun festen Materialbeträge stimmen mit dem CHM überein.

## Datenregeln und Tests

`null` ist kein Nullpreis. Echte numerische Nullen bleiben 0; fehlende Werte und Ausdrücke wie `> 0.00 CHF` werden nicht zu Preisen umgedeutet. CHF-Beträge stehen in `amountsCHF`, nicht in `socialPoints`/`privateMin`/`privateMax`; Originalangaben stehen zusätzlich in `pointTexts`. Material- und Clusterplatzhalter bleiben mit ihren exakten Kennungen durchsuchbar. Preise sind endlich und nicht negativ; vorhandenes Minimum darf das Maximum nicht überschreiten.

Notizen bewahren Absätze, Listen und verschachtelte Paketbestandteile. `excludes` enthält nur explizite Nichtkumulationsziele, nicht beliebige Querverweise oder bedingte Kumulationshinweise. `members` und `packages` werden unabhängig aus ihren jeweiligen CHM-Stellen gelesen und im Integrationstest auf Gegenseitigkeit geprüft. `sourcePath` verweist relativ auf die ursprüngliche CHM-Seite; `shortSourcePage` separat auf die Kurztext-Ausgabe. AL-Aliasse stehen mit Ziel und Herkunft unter `aliases`.

Die Tests verwenden erfundene HTML-Fragmente statt kopierter Tariftext-Fixtures. Bei vorhandenen Originalen läuft zusätzlich der vollständige reale Importtest; ohne lokale Originale wird nur dieser Integrationstest übersprungen.
