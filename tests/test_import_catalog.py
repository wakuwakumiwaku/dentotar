"""Importer contracts use only invented HTML, never redistributed tariff text."""
import copy
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("dentotar_import", ROOT / "scripts/import_catalog.py")
assert spec is not None and spec.loader is not None
importer = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = importer
spec.loader.exec_module(importer)


def metadata(label, value):
    return f'<tr><td></td><td></td><td class="td3"><b>{label}</b></td><td class="td4">{value}</td></tr>'


def fixture(code="4.9901", notes="", social="0.00", minimum="0", maximum="0"):
    rows = metadata("Gültigkeit", "01.01.25 - 31.12.99")
    if social is not None:
        rows += metadata("TP (UV/MV/IV)", social)
    if minimum is not None:
        rows += metadata("TP (PP) min", minimum)
    if maximum is not None:
        rows += metadata("TP (PP) max", maximum)
    rows += metadata("Kapitel", "01.01") + metadata("Deckung", "UV/MV/IV")
    rows += metadata("MwSt-Satz", "Kein Satz")
    return f'''<html><body><p>Not a tariff note</p><table class="tdata">
    <tr><th class="theader1">{code}</th><th class="theader2">Synthetic title</th></tr>
    {rows}<tr><td></td><td></td><td class="td4">{notes}</td></tr></table></body></html>'''


def position(**kwargs):
    return importer.parse_position_html(fixture(**kwargs), "222/01/01.01/synthetic.html")[0]


class ImporterTests(unittest.TestCase):
    def test_zero_is_not_missing(self):
        row = position()
        self.assertEqual((row["socialPoints"], row["privateMin"], row["privateMax"]), (0, 0, 0))
        row = position(social=None, minimum=None, maximum=None)
        self.assertEqual((row["socialPoints"], row["privateMin"], row["privateMax"]), (None, None, None))

    def test_currency_and_open_amount_are_not_points(self):
        row = position(code="4.9901.M", social="21.50 CHF", minimum=None, maximum=None)
        self.assertIsNone(row["socialPoints"])
        self.assertEqual(row["amountsCHF"]["social"], 21.5)
        self.assertEqual(row["kind"], "material")
        row = position(code="4.xxxx.A.n", social="&gt; 0.00 CHF", minimum=None, maximum=None)
        self.assertIsNone(row["socialPoints"])
        self.assertIsNone(row["amountsCHF"]["social"])

    def test_header_not_filename_is_identity(self):
        row, alias = importer.parse_position_html(fixture(code="4.9901.LP"), "222/15/15.01/wrong.html")
        self.assertEqual(row["code"], "4.9901.LP")
        self.assertEqual(row["kind"], "package")
        self.assertIsNone(alias)

    def test_alias_is_separate_from_canonical(self):
        html = fixture(code="4.9901.LP", notes='Alias-Platzhalter auf das Leistungspaket <a href="target.lp.html">4.9901.LP</a>')
        row, alias = importer.parse_position_html(html, "222/01/01.01/item.AL.html")
        self.assertIsNone(row)
        self.assertEqual(alias["code"], "4.9901.LP")
        self.assertEqual(alias["targetCode"], "4.9901.LP")
        self.assertEqual(alias["targetPath"], "222/01/01.01/target.lp.html")

    def test_nested_notes_members_and_only_explicit_exclusions(self):
        note = '''<p>First restriction.</p><p>Second restriction.<br>Second line.</p>
        See <a href="other.html">4.9902</a>.
        Leistung <a href="self.html">4.9901</a> ist nicht kumulierbar mit
        <ul class="cumulationList"><li>Leistung <a href="excluded.html">4.9903</a> «Other title»</li></ul>
        <p>Later advice: <a href="later.html">4.9904</a>.</p>
        <table class="tablelp"><tr><td colspan="2">Package includes:</td></tr>
        <tr><td class="td1lp"><a href="member.html">4.9905</a></td><td>Nested component text</td></tr></table>'''
        row = position(notes=note)
        self.assertEqual(row["excludes"], ["4.9903"])
        self.assertEqual(row["members"], ["4.9905"])
        self.assertIn("Nested component text", row["notes"])
        self.assertIn("First restriction.\n\nSecond restriction.\nSecond line.", row["notes"])
        self.assertIn("- Leistung 4.9903", row["notes"])
        self.assertNotIn("Not a tariff note", row["notes"])

    def test_package_metadata_is_not_note_or_exclusion(self):
        html = fixture().replace('</table></body>', metadata("Mitglied von LP", '<a href="package.lp.html">4.9901.LP</a>') + '</table></body>')
        row, _ = importer.parse_position_html(html, "222/01/01.01/4.9901.html")
        self.assertEqual(row["packages"], ["4.9901.LP"])
        self.assertEqual(row["notes"], "")
        self.assertEqual(row["excludes"], [])

    def test_duplicates_and_invalid_numeric_values_fail(self):
        row = position()
        with self.assertRaisesRegex(ValueError, "Duplicate canonical"):
            importer.validate_positions([row, copy.deepcopy(row)])
        for field, value in [("socialPoints", math.nan), ("privateMin", -1), ("privateMax", math.inf), ("socialPoints", True)]:
            invalid = copy.deepcopy(row)
            invalid[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                importer.validate_positions([invalid])
        with self.assertRaisesRegex(ValueError, "privateMin"):
            importer.validate_positions([position(minimum="5", maximum="2")])

    def test_reference_validation_warns_without_fabricating_rows(self):
        row = position(notes='See <a href="absent.html">4.9999</a>')
        warnings = importer.validate_positions([row])
        self.assertEqual(len(warnings), 1)
        self.assertIn("4.9999", warnings[0])

    def test_index_notes_exclude_listing_rows(self):
        html = '''<table class="tdata"><tr><th class="theader1">01.01</th><th class="theader2">Synthetic section</th></tr>
        <tr><td class="td2"></td><td class="td4"><p>Section restriction</p><ul><li>List note</li></ul></td></tr>
        <tr><td class="td2"><a href="4.9901.html">4.9901</a></td><td class="td4">Listing title</td></tr></table>'''
        result = importer.parse_index_html(html, "222/01/01.01/index.html")
        self.assertEqual(result["id"], "01.01")
        self.assertIn("Section restriction", result["notes"])
        self.assertIn("- List note", result["notes"])
        self.assertNotIn("Listing title", result["notes"])

    def test_pdf_mapping_requires_actual_header_not_reference(self):
        text = ('   4.9901  Synthetic title\n          Gültigkeit  01.01.25\n'
                '\f   4.9902  Merely a reference\n          Some prose\n'
                '   4.9903.LP  Package title\n          Gültigkeit  01.01.25\n')
        pages, warnings = importer.map_pdf_pages(text)
        self.assertEqual(pages, {"4.9901": 1, "4.9903.LP": 2})
        self.assertEqual(warnings, [])

    def test_shorttext_titles_preserve_wrapped_raw_text(self):
        raw = '''Nr. UV/MV/IV PP (min) - PP (max) Kurztext
4.9901 1 2 - 3
Invented multiline
short title
4.9902 4 5 - 6 Inline title
Kapitel 02: Not part of previous title
4.9903.M CHF 12.30 Material title
4.xxxx.A.n CHF >0.00 Open amount
'''
        rows = importer.parse_shorttext_raw(raw)
        self.assertEqual(rows["4.9901"]["title"], "Invented multiline short title")
        self.assertEqual(rows["4.9902"]["title"], "Inline title")
        self.assertEqual(rows["4.9903.M"]["amountCHF"], 12.3)
        self.assertIsNone(rows["4.xxxx.A.n"]["amountCHF"])

    def test_pdf_mapping_handles_single_space_wrapping_and_title_validation(self):
        text = ('  4.9901.LP Synthetic package UV/\n'
                '             MV\n          Gültigkeit 01.01.25\n'
                '  4.9902 Incorrect title\n          Gültigkeit 01.01.25\n')
        pages, warnings = importer.map_pdf_pages(text, {"4.9901.LP": "Synthetic package UV/MV", "4.9902": "Expected title"})
        self.assertEqual(pages, {"4.9901.LP": 1})
        self.assertEqual(len(warnings), 1)
        self.assertIn("4.9902", warnings[0])
        pages, warnings = importer.map_pdf_pages(text + "\f" + text)
        self.assertEqual(pages, {})
        self.assertEqual(len(warnings), 2)

    def test_literal_identifiers_and_unknown_metadata_fail_closed(self):
        for code in ("4.9901.lp", "4.9901 ", "4.09901", "4.9901.X"):
            if code.endswith(" "):
                continue  # surrounding HTML whitespace is not part of an ID.
            with self.subTest(code=code), self.assertRaises(ValueError):
                position(code=code)
        html = fixture().replace("Gültigkeit", "Unknown metadata")
        with self.assertRaisesRegex(ValueError, "Unknown metadata"):
            importer.parse_position_html(html, "222/01/01.01/4.9901.html")
        with self.assertRaisesRegex(ValueError, "Invalid alias"):
            importer.parse_position_html(fixture(), "222/01/01.01/4.9901.AL.html")

    def test_supported_social_coverage_labels(self):
        for label, coverage in (("TP (UV/MV)", "UV/MV"), ("TP (IV)", "IV")):
            html = fixture(social="4.50").replace("TP (UV/MV/IV)", label).replace(">UV/MV/IV<", f">{coverage}<")
            row, _ = importer.parse_position_html(html, "222/01/01.01/4.9901.html")
            self.assertEqual(row["socialPoints"], 4.5)
            self.assertEqual(row["coverage"], coverage)

    def test_shorttext_independent_layout_scan_rejects_missing_or_changed_rows(self):
        raw = "4.9901 1 2 - 3 First synthetic title\n4.9902 4 5 - 6 Second synthetic title\n"
        rows = importer.parse_shorttext_raw(raw)
        self.assertEqual(importer.crosscheck_shorttext_layout(raw, rows), 2)
        with self.assertRaisesRegex(ValueError, "coverage differs"):
            importer.crosscheck_shorttext_layout(raw.splitlines()[0], rows)
        with self.assertRaisesRegex(ValueError, "disagreement"):
            importer.crosscheck_shorttext_layout(raw.replace("1 2 - 3", "8 2 - 3"), rows)

    def test_missing_sources_and_checksum_changes_fail_clearly(self):
        cache = Path(os.environ.get("TMPDIR", str(Path.home() / ".cache/dentotar")))
        cache.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="dentotar-fixture-", dir=cache) as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "Missing.*downloads.json"):
                importer.verify_sources(root)
            source_dir = root / "sources"
            source_dir.mkdir()
            records = []
            for filename in importer.SOURCE_INFO:
                content = b"synthetic provenance fixture"
                (source_dir / filename).write_bytes(content)
                records.append({"file": filename, "bytes": len(content), "sha256": importer.sha256(content).hexdigest(), "url": "https://example.invalid/source"})
            (source_dir / "downloads.json").write_text(json.dumps(records), encoding="utf-8")
            self.assertEqual(len(importer.verify_sources(root)), 3)
            (source_dir / records[0]["file"]).write_bytes(b"tampered fixture")
            with self.assertRaisesRegex(ValueError, "checksum/size mismatch"):
                importer.verify_sources(root)

    def test_shorttext_never_overwrites_authoritative_nulls(self):
        row = position(social=None, minimum=None, maximum=None)
        short = {row["code"]: {"title": "Short synthetic name", "socialPoints": 5, "privateMin": 0, "privateMax": 0, "page": 2, "amountCHF": None}}
        report = importer.compare_shorttext([row], short)
        self.assertEqual(report["rowsCompared"], 1)
        self.assertEqual(len(report["mismatches"]), 3)
        self.assertIsNone(row["socialPoints"])
        self.assertIsNone(row["privateMin"])
        self.assertEqual(row["shortTitle"], "Short synthetic name")


@unittest.skipUnless(all((ROOT / "sources" / filename).is_file() for filename in importer.SOURCE_INFO), "official local sources are intentionally not tracked")
class OfficialSourcesTests(unittest.TestCase):
    def test_real_sources_complete_coverage_and_provenance(self):
        catalog = importer.build_catalog(ROOT)
        stats = catalog["statistics"]
        expected = {"positions": 642, "aliases": 44, "chapters": 16, "sections": 109,
                    "htmlFiles": 812, "sourcePages": 642, "shortTitles": 641,
                    "socialPoints": 597, "privateRanges": 578, "fixedCHFAmounts": 9,
                    "exclusionEdges": 128, "packageMemberEdges": 183, "packageMembershipEdges": 183,
                    "shorttextLayoutRows": 641, "shorttextNumericRowsCompared": 630,
                    "shorttextScalarComparisons": 1881, "shorttextMismatches": 121,
                    "shorttextMismatchedPositions": 76, "referenceWarnings": 0,
                    "warningCount": 1, "tariffPdfPages": 206, "shorttextPdfPages": 24}
        for key, value in expected.items():
            with self.subTest(statistic=key):
                self.assertEqual(stats[key], value)
        by_code = {row["code"]: row for row in catalog["positions"]}
        base = by_code["4.0000"]
        self.assertEqual((base["socialPoints"], base["privateMin"], base["privateMax"]), (73.2, 62.2, 84.2))
        self.assertEqual(base["excludes"], ["4.0020"])
        self.assertEqual(base["sourcePage"], 4)
        package = by_code["4.0000.LP"]
        self.assertEqual((package["socialPoints"], package["coverage"]), (194.4, "UV/MV"))
        self.assertEqual(package["sourcePage"], 175)
        self.assertEqual(len(package["members"]), 9)
        self.assertIsNone(package["privateMin"])
        self.assertIsNone(by_code["4.0300"]["socialPoints"])
        self.assertIsNone(by_code["4.2600"]["shortTitle"])
        self.assertEqual(catalog["shorttextComparison"]["missingShorttext"], ["4.2600"])
        self.assertEqual(catalog["shorttextComparison"]["missingCanonical"], [])
        self.assertEqual(len(catalog["sources"]), 3)
        self.assertTrue(all(len(source["sha256"]) == 64 for source in catalog["sources"]))
        importer.validate_positions(catalog["positions"], catalog["aliases"])
        # The two independently parsed package relations must agree exactly.
        members = {(row["code"], target) for row in catalog["positions"] for target in row["members"]}
        memberships = {(target, row["code"]) for row in catalog["positions"] for target in row["packages"]}
        self.assertEqual(members, memberships)


if __name__ == "__main__":
    unittest.main()
