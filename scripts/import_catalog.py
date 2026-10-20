#!/usr/bin/env python3
"""Rebuild the local, ignored catalog from hash-verified official source files.

Python standard library only. External tools: 7z, pdftotext. No network access.
The source CHM is freshly expanded in a temporary cache directory on every run;
pre-existing extracted HTML and text files are deliberately not trusted.
"""
from __future__ import annotations

from collections import Counter
from hashlib import sha256
from html.parser import HTMLParser
import json
import math
import os
from pathlib import Path
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CODE_PATTERN = r"(?:4\.\d{4}(?:\.(?:LP|M))?|4\.xxxx\.[A-H]\.n|[DMP]\.yyyy)"
CODE = re.compile(CODE_PATTERN + r"\Z")
HEADING = re.compile(r"\d{2}(?:\.\d{2})*\Z")
NUMBER = r"\d+(?:[.,]\d+)?"
TRIPLE = re.compile(rf"^({NUMBER})\s+({NUMBER})\s*[-–]\s*({NUMBER})(?:\s+(.*))?$")
AMOUNT = re.compile(rf"^CH(?:F)?\s*(>\s*)?({NUMBER})(?:\s+(.*))?$")
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
SOURCE_INFO = {
    "sso-uv-mv-iv-2025.chm": ("tariff-chm", "Zahnarzt-Tarif UV/MV/IV (SSO), Offline-Tarifbrowser", "V2.00 / 01.01.2025; Bearbeitungsstand 18.12.2024"),
    "sso-uv-mv-iv-2025.pdf": ("tariff-pdf", "Zahnarzt-Tarif UV/MV/IV (SSO), Volltext-PDF", "V2.00 / 01.01.2025; Bearbeitungsstand 18.12.2024"),
    "dentotar-kurztext.pdf": ("shorttext-pdf", "DENTOTAR® Kurztext-Ausgabe für Privatpatienten", "25.1; März 2025"),
}


class Node:
    def __init__(self, tag="", attrs=()):
        self.tag = tag
        self.attrs = dict(attrs)
        self.children = []

    def has_class(self, name):
        return name in (self.attrs.get("class") or "").split()

    def walk(self, tag=None):
        for child in self.children:
            if isinstance(child, Node):
                if tag is None or child.tag == tag:
                    yield child
                yield from child.walk(tag)


class DocumentParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("document")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def raw_text(node):
    if isinstance(node, str):
        return re.sub(r"\s+", " ", node.replace("\xa0", " "))
    if node.tag in {"script", "style"}:
        return ""
    inner = "".join(raw_text(child) for child in node.children)
    if node.tag == "br":
        return "\n"
    if node.tag == "li":
        return "\n- " + inner.strip() + "\n"
    if node.tag == "p":
        return "\n\n" + inner.strip() + "\n\n"
    if node.tag in {"tr", "table", "ul", "ol", "div", "h1", "h2", "h3"}:
        return "\n" + inner.strip() + "\n"
    if node.tag in {"td", "th"}:
        return inner + "\t"
    return inner


def text(node):
    result = "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in raw_text(node).splitlines())
    return re.sub(r"\n{3,}", "\n\n", result).strip()


def one_line(node):
    return " ".join(text(node).split())


def read_table(html):
    parser = DocumentParser()
    parser.feed(html)
    parser.close()
    tables = [node for node in parser.root.walk("table") if node.has_class("tdata")]
    if len(tables) != 1:
        raise ValueError(f"Expected exactly one table.tdata, found {len(tables)}")
    table = tables[0]
    headers = {}
    for node in table.walk("th"):
        for name in ("theader1", "theader2"):
            if node.has_class(name):
                if name in headers:
                    raise ValueError(f"Duplicate {name}")
                headers[name] = one_line(node)
    if set(headers) != {"theader1", "theader2"} or not all(headers.values()):
        raise ValueError("Missing code/title in th.theader1/th.theader2")
    return table, headers["theader1"], headers["theader2"]


def direct_rows(table):
    for child in table.children:
        if isinstance(child, Node):
            if child.tag == "tr":
                yield child
            elif child.tag in {"tbody", "thead", "tfoot"}:
                yield from direct_rows(child)


def cells(row):
    return [child for child in row.children if isinstance(child, Node) and child.tag in {"td", "th"}]


def code_links(node):
    return list(dict.fromkeys(one_line(link) for link in node.walk("a") if CODE.fullmatch(one_line(link))))


def prefix_before(root, target):
    parts = []

    def visit(node):
        if node is target:
            return True
        if isinstance(node, str):
            parts.append(raw_text(node))
            return False
        for child in node.children:
            if visit(child):
                return True
        return False

    visit(root)
    return " ".join("".join(parts).split())


def extract_exclusions(note_cells):
    """Only targets in the explicit 'ist nicht kumulierbar mit' list.

    Ordinary cross-references, positive/conditional cumulation advice and package
    components must never become unconditional exclusion edges.
    """
    result = []
    for cell in note_cells:
        found_lists = 0
        for listing in cell.walk("ul"):
            if re.search(r"ist nicht kumulierbar mit\s*$", prefix_before(cell, listing), re.I):
                found_lists += 1
                for item in listing.children:
                    if isinstance(item, Node) and item.tag == "li":
                        targets = code_links(item)
                        if not targets:
                            raise ValueError("Explicit exclusion list item has no code")
                        result.append(targets[0])
        occurrences = len(re.findall(r"ist nicht kumulierbar mit", one_line(cell), re.I))
        if occurrences != found_lists:
            raise ValueError("Unrecognized explicit exclusion markup; refusing to lose targets")
    return list(dict.fromkeys(result))


def numeric_value(value):
    """A strict scalar: no currencies, inequalities, zero-filling or rounding."""
    value = value.strip()
    if re.fullmatch(NUMBER, value):
        number = float(value.replace(",", "."))
        if math.isfinite(number) and number >= 0:
            return number
        raise ValueError(f"Invalid number: {value!r}")
    if not value or re.fullmatch(rf">\s*{NUMBER}(?:\s*CHF)?", value):
        return None
    if re.fullmatch(rf"{NUMBER}\s*CHF", value):
        return None  # CHF amounts are not tax points.
    raise ValueError(f"Unsupported point/amount expression: {value!r}")


def amount_chf(value):
    if re.fullmatch(rf"{NUMBER}\s*CHF", value.strip()):
        return numeric_value(value.strip()[:-3].strip())
    return None


def parse_position_html(html, source_path, short_title=None, source_page=None):
    table, code, title = read_table(html)
    if not CODE.fullmatch(code):
        raise ValueError(f"Invalid literal position identifier {code!r} in {source_path}")
    if source_path.lower().endswith(".al.html") or "Alias-Platzhalter" in text(table):
        links = [a for a in table.walk("a") if CODE.fullmatch(one_line(a))]
        if "Alias-Platzhalter" not in text(table) or len(links) != 1:
            raise ValueError(f"Invalid alias markup: {source_path}")
        target = links[0]
        return None, {"code": code, "title": title, "sourcePath": source_path,
                      "targetCode": one_line(target),
                      "targetPath": posixpath.normpath(posixpath.join(posixpath.dirname(source_path), target.attrs["href"]))}
    metadata = {}
    note_cells = []
    for row in direct_rows(table):
        row_cells = cells(row)
        if any(cell.tag == "th" for cell in row_cells):
            continue
        labels = [i for i, cell in enumerate(row_cells) if cell.has_class("td3") or cell.has_class("td3Alt")]
        if labels:
            if len(labels) != 1 or labels[0] + 1 >= len(row_cells):
                raise ValueError(f"Malformed metadata row: {source_path}")
            index = labels[0]
            label = one_line(row_cells[index])
            if label in metadata:
                raise ValueError(f"Duplicate metadata {label}: {source_path}")
            metadata[label] = row_cells[index + 1]
        else:
            note_cells.extend(cell for cell in row_cells if one_line(cell))
    values = {key: one_line(value) for key, value in metadata.items()}
    known = {"Gültigkeit", "TP (UV/MV/IV)", "TP (UV/MV)", "TP (IV)", "TP (PP) min", "TP (PP) max", "TP (PP)", "MwSt-Satz", "Kapitel", "Deckung", "Mitglied von LP", "Referenz-Code"}
    if set(values) - known:
        raise ValueError(f"Unknown metadata labels in {source_path}: {sorted(set(values) - known)}")
    section = values.get("Kapitel", "")
    if not HEADING.fullmatch(section):
        raise ValueError(f"Missing/invalid chapter metadata in {source_path}: {section!r}")
    social_labels = [label for label in values if label.startswith("TP (") and label not in {"TP (PP)", "TP (PP) min", "TP (PP) max"}]
    if len(social_labels) > 1:
        raise ValueError(f"Ambiguous social point fields: {source_path}")
    social = values.get(social_labels[0], "") if social_labels else ""
    private_fixed = values.get("TP (PP)", "")
    minimum = values.get("TP (PP) min", private_fixed)
    maximum = values.get("TP (PP) max", private_fixed)
    chapter = section.split(".")[0]
    kind = ("package" if code.endswith(".LP") else "material" if chapter == "19" or code.endswith(".M") else "reference" if chapter == "20" else "service")
    members = []
    for cell in note_cells:
        for component in cell.walk("td"):
            if component.has_class("td1lp"):
                members.extend(code_links(component))
    references = code_links(table)
    reference_code = values.get("Referenz-Code", "")
    if CODE.fullmatch(reference_code):
        references.append(reference_code)
    row = {
        "code": code, "title": title, "shortTitle": short_title,
        "chapter": chapter, "section": section,
        "socialPoints": numeric_value(social), "privateMin": numeric_value(minimum), "privateMax": numeric_value(maximum),
        "coverage": values.get("Deckung", ""), "validity": values.get("Gültigkeit", ""), "vat": values.get("MwSt-Satz", ""),
        "notes": "\n\n".join(text(cell) for cell in note_cells if text(cell)),
        "excludes": extract_exclusions(note_cells), "members": list(dict.fromkeys(members)),
        "packages": code_links(metadata["Mitglied von LP"]) if "Mitglied von LP" in metadata else [],
        "sourcePath": source_path, "sourcePage": source_page, "kind": kind,
        "pointTexts": {key: value for key, value in values.items() if key.startswith("TP (")},
        "amountsCHF": {"social": amount_chf(social), "private": amount_chf(private_fixed)},
        "referenceCode": reference_code or None,
        "references": list(dict.fromkeys(ref for ref in references if ref != code)),
    }
    return row, None


def parse_index_html(html, source_path):
    table, code, title = read_table(html)
    if not HEADING.fullmatch(code) and code != "222":
        raise ValueError(f"Invalid index identifier {code!r}: {source_path}")
    notes = []
    for row in direct_rows(table):
        row_cells = cells(row)
        if not row_cells or any(cell.tag == "th" for cell in row_cells):
            continue
        # Navigation rows have an identifier in their FIRST cell. Note rows have
        # an empty first cell even when their prose contains other code links.
        if one_line(row_cells[0]):
            continue
        notes.extend(text(cell) for cell in row_cells[1:] if text(cell))
    return {"id": code, "title": title, "notes": "\n\n".join(notes), "sourcePath": source_path}


def validate_positions(positions, aliases=(), chapters=None, sections=None):
    seen = {}
    for row in positions:
        code = row["code"]
        if not CODE.fullmatch(code):
            raise ValueError(f"Invalid canonical code: {code!r}")
        if code in seen:
            raise ValueError(f"Duplicate canonical code {code}: {seen[code]} and {row['sourcePath']}")
        seen[code] = row["sourcePath"]
        for field in ("socialPoints", "privateMin", "privateMax"):
            value = row[field]
            if value is not None and (type(value) not in {int, float} or not math.isfinite(value) or value < 0):
                raise ValueError(f"Invalid {field} for {code}: {value!r}")
        if row["privateMin"] is not None and row["privateMax"] is not None and row["privateMin"] > row["privateMax"]:
            raise ValueError(f"privateMin > privateMax for {code}")
        for value in row["amountsCHF"].values():
            if value is not None and (type(value) not in {int, float} or not math.isfinite(value) or value < 0):
                raise ValueError(f"Invalid CHF amount for {code}")
    warnings = []
    for row in positions:
        for target in dict.fromkeys(row["references"] + row["excludes"] + row["members"] + row["packages"]):
            if target not in seen:
                warnings.append(f"{row['code']}: unresolved position reference {target}")
        if chapters is not None and row["chapter"] not in chapters:
            warnings.append(f"{row['code']}: unresolved chapter {row['chapter']}")
        if sections is not None and row["section"] not in sections:
            warnings.append(f"{row['code']}: unresolved section {row['section']}")
    for alias in aliases:
        if alias["targetCode"] not in seen:
            warnings.append(f"{alias['sourcePath']}: unresolved alias {alias['targetCode']}")
    return warnings


def map_pdf_pages(layout_text, expected_titles=None):
    pages = {}
    warnings = []
    ambiguous = set()
    header = re.compile(rf"^\s*({CODE_PATTERN})\s+(\S.*)$")
    validity = re.compile(r"^\s*Gültigkeit\s+\d{2}\.\d{2}\.\d{2}")
    for page_number, page in enumerate(layout_text.split("\f"), 1):
        lines = page.splitlines()
        # Anchor on metadata, then find the immediately preceding leading code
        # header. Package/material headers use ONE space; long titles wrap.
        # Ordinary component references and AL listings have no validity block.
        for index, line in enumerate(lines):
            if not validity.match(line):
                continue
            preceding = []
            for previous in reversed(lines[max(0, index - 10):index]):
                if not previous.strip():
                    continue
                match = header.match(previous)
                if match:
                    code = match[1]
                    title = " ".join(" ".join((match[2], *reversed(preceding))).split())
                    # A PDF line can wrap directly after '/', e.g. UV/\nMV.
                    # Compare typography only; retain the exact CHM title.
                    normalized = re.sub(r"\s*/\s*", "/", title)
                    expected = re.sub(r"\s*/\s*", "/", " ".join(expected_titles.get(code, "").split())) if expected_titles is not None else None
                    if expected_titles is not None and normalized != expected:
                        warnings.append(f"{code}: PDF/CHM header title differs; sourcePage left null")
                        break
                    if code in pages:
                        ambiguous.add(code)
                    else:
                        pages[code] = page_number
                    break
                preceding.append(previous.strip())
                if len(preceding) > 4:
                    break
    for code in sorted(ambiguous):
        del pages[code]
        warnings.append(f"{code}: multiple PDF position headers; sourcePage left null")
    return pages, warnings


def parse_shorttext_raw(raw):
    rows = {}
    start = re.compile(rf"^\s*({CODE_PATTERN})\s+(.+)$")
    for page_number, page in enumerate(raw.split("\f"), 1):
        current = None
        for line in page.splitlines():
            line = line.strip()
            if not line:
                continue
            match = start.match(line)
            if match:
                code, rest = match.groups()
                if code in rows:
                    raise ValueError(f"Duplicate Kurztext code: {code}")
                triple = TRIPLE.fullmatch(rest)
                amount = AMOUNT.fullmatch(rest)
                if triple:
                    a, b, c, title = triple.groups()
                    values = {"socialPoints": numeric_value(a), "privateMin": numeric_value(b), "privateMax": numeric_value(c), "amountCHF": None}
                elif amount:
                    greater, number, title = amount.groups()
                    values = {"socialPoints": None, "privateMin": None, "privateMax": None, "amountCHF": None if greater else numeric_value(number)}
                else:
                    raise ValueError(f"Unrecognized Kurztext numeric row: {code}: {rest}")
                current = {"title": title or "", "page": page_number, **values}
                rows[code] = current
            elif line.startswith(("Kapitel ", "©", "DENTOTAR", "Kurztext,", "Nr.")):
                current = None
            elif current is not None:
                separator = "" if current["title"].endswith(("-", "/")) else " "
                current["title"] = (current["title"] + separator + line).strip()
    if any(not row["title"] for row in rows.values()):
        raise ValueError("Kurztext position with empty short title")
    return rows


def crosscheck_shorttext_layout(layout, raw_rows):
    """Independent table-row scan: every leading code must parse and agree."""
    scanned = {}
    start = re.compile(rf"^\s*({CODE_PATTERN})\s+(.+)$")
    for page in layout.split("\f"):
        for line in page.splitlines():
            match = start.match(line)
            if not match:
                continue
            code, rest = match.groups()
            if code in scanned:
                raise ValueError(f"Duplicate Kurztext layout row: {code}")
            numeric = TRIPLE.fullmatch(rest.strip())
            amount = AMOUNT.fullmatch(rest.strip())
            if numeric:
                scanned[code] = tuple(numeric_value(value) for value in numeric.groups()[:3])
                expected = tuple(raw_rows[code][field] for field in ("socialPoints", "privateMin", "privateMax"))
            elif amount:
                scanned[code] = (None if amount[1] else numeric_value(amount[2]),)
                expected = (raw_rows[code]["amountCHF"],)
            else:
                raise ValueError(f"Unparsed independent Kurztext layout row {code}")
            if scanned[code] != expected:
                raise ValueError(f"Kurztext raw/layout disagreement for {code}")
    if set(scanned) != set(raw_rows):
        raise ValueError("Kurztext raw/layout coverage differs")
    return len(scanned)


def compare_shorttext(positions, short_rows):
    mismatches = []
    compared = 0
    scalar_comparisons = 0
    matched = set()
    for row in positions:
        short = short_rows.get(row["code"])
        if short is None:
            continue
        matched.add(row["code"])
        row["shortTitle"] = short["title"]
        row["shortSourcePage"] = short["page"]
        fields = ("socialPoints", "privateMin", "privateMax") if not row["code"].endswith(".M") and row["kind"] not in {"material", "reference"} else ()
        if fields or short["amountCHF"] is not None:
            compared += 1
        for field in fields:
            scalar_comparisons += 1
            if row[field] != short[field]:
                mismatches.append({"code": row["code"], "field": field, "authoritative": row[field], "shorttext": short[field], "shorttextPage": short["page"]})
        if short["amountCHF"] is not None:
            for field in ("social", "private"):
                scalar_comparisons += 1
                actual = row["amountsCHF"][field]
                if actual != short["amountCHF"]:
                    mismatches.append({"code": row["code"], "field": f"amountsCHF.{field}", "authoritative": actual, "shorttext": short["amountCHF"], "shorttextPage": short["page"]})
    return {"rows": len(short_rows), "rowsMatched": len(matched), "rowsCompared": compared,
            "scalarComparisons": scalar_comparisons, "mismatchCount": len(mismatches),
            "mismatchedPositions": len({item["code"] for item in mismatches}),
            "missingCanonical": sorted(set(short_rows) - matched),
            "missingShorttext": sorted({row["code"] for row in positions} - matched),
            "mismatches": mismatches}


def run_tool(args):
    try:
        return subprocess.run(args, check=True, capture_output=True).stdout
    except FileNotFoundError as exc:
        raise ValueError(f"Required command not installed: {args[0]}") from exc
    except subprocess.CalledProcessError as exc:
        raise ValueError(f"{args[0]} failed ({exc.returncode}): {exc.stderr.decode('utf-8', errors='replace')}") from exc


def verify_sources(root):
    source_dir = root / "sources"
    manifest = source_dir / "downloads.json"
    if not manifest.is_file():
        raise ValueError(f"Missing {manifest}; acquire the official sources first")
    records = {item["file"]: item for item in json.loads(manifest.read_text(encoding="utf-8"))}
    result = []
    for filename, (source_id, title, version) in SOURCE_INFO.items():
        path = source_dir / filename
        if not path.is_file() or filename not in records:
            raise ValueError(f"Missing official source/manifest entry: {path}")
        data = path.read_bytes()
        digest = sha256(data).hexdigest()
        if digest != records[filename]["sha256"] or len(data) != records[filename]["bytes"]:
            raise ValueError(f"Source checksum/size mismatch: {path}")
        result.append({"id": source_id, "title": title, "url": records[filename]["url"], "version": version, "sha256": digest, "bytes": len(data), "file": filename})
    return result


def build_catalog(root=ROOT):
    sources = verify_sources(root)
    source_dir = root / "sources"
    full_layout = run_tool(["pdftotext", "-layout", str(source_dir / "sso-uv-mv-iv-2025.pdf"), "-"]).decode("utf-8")
    short_layout = run_tool(["pdftotext", "-layout", str(source_dir / "dentotar-kurztext.pdf"), "-"]).decode("utf-8")
    short_raw = run_tool(["pdftotext", "-raw", str(source_dir / "dentotar-kurztext.pdf"), "-"]).decode("utf-8")
    warnings = []
    short_rows = parse_shorttext_raw(short_raw)
    layout_coverage = crosscheck_shorttext_layout(short_layout, short_rows)
    cache = Path(os.environ.get("TMPDIR", str(Path.home() / ".cache/dentotar")))
    cache.mkdir(parents=True, exist_ok=True)
    positions, aliases, chapters, sections = [], [], [], []
    tariff_notes = ""
    with tempfile.TemporaryDirectory(prefix="dentotar-import-", dir=cache) as temporary:
        expanded = Path(temporary)
        run_tool(["7z", "x", "-y", f"-o{expanded}", str(source_dir / "sso-uv-mv-iv-2025.chm")])
        html_files = sorted((expanded / "222").rglob("*.html"))
        if not html_files:
            raise ValueError("CHM extraction contains no 222 tariff HTML")
        for path in html_files:
            relative = path.relative_to(expanded).as_posix()
            html = path.read_text(encoding="utf-8")
            try:
                if path.name.lower() == "index.html":
                    item = parse_index_html(html, relative)
                    if item["id"] == "222":
                        tariff_notes = item["notes"]
                    elif "." in item["id"]:
                        sections.append(item)
                    else:
                        chapters.append(item)
                else:
                    row, alias = parse_position_html(html, relative)
                    if alias is not None:
                        aliases.append(alias)
                    else:
                        positions.append(row)
            except ValueError as exc:
                raise ValueError(f"{relative}: {exc}") from exc
    for kind, headings in (("chapter", chapters), ("section", sections)):
        if len({item["id"] for item in headings}) != len(headings):
            raise ValueError(f"Duplicate {kind} identifier")
    positions.sort(key=lambda item: item["code"])
    chapters.sort(key=lambda item: item["id"])
    sections.sort(key=lambda item: item["id"])
    reference_warnings = validate_positions(positions, aliases, {x["id"] for x in chapters}, {x["id"] for x in sections})
    warnings.extend(reference_warnings)
    pages, page_warnings = map_pdf_pages(full_layout, {row["code"]: row["title"] for row in positions})
    warnings.extend(page_warnings)
    for row in positions:
        row["sourcePage"] = pages.get(row["code"])
    comparisons = compare_shorttext(positions, short_rows)
    for code in comparisons["missingCanonical"]:
        warnings.append(f"Kurztext code absent from CHM: {code}")
    for code in comparisons["missingShorttext"]:
        warnings.append(f"CHM code absent from Kurztext: {code}")
    missing_pages = sorted(row["code"] for row in positions if row["sourcePage"] is None)
    warnings.extend(f"{code}: no unambiguous leading PDF position header; sourcePage left null" for code in missing_pages)
    statistics = {
        "positions": len(positions), "aliases": len(aliases), "chapters": len(chapters), "sections": len(sections),
        "htmlFiles": len(html_files), "kinds": dict(sorted(Counter(row["kind"] for row in positions).items())),
        "socialPoints": sum(row["socialPoints"] is not None for row in positions),
        "privateRanges": sum(row["privateMin"] is not None and row["privateMax"] is not None for row in positions),
        "fixedCHFAmounts": sum(row["amountsCHF"]["social"] is not None for row in positions),
        "shortTitles": sum(row["shortTitle"] is not None for row in positions),
        "sourcePages": len(positions) - len(missing_pages),
        "notes": sum(bool(row["notes"]) for row in positions),
        "chapterNotes": sum(bool(row["notes"]) for row in chapters),
        "sectionNotes": sum(bool(row["notes"]) for row in sections),
        "exclusionEdges": sum(len(row["excludes"]) for row in positions),
        "packageMemberEdges": sum(len(row["members"]) for row in positions),
        "packageMembershipEdges": sum(len(row["packages"]) for row in positions),
        "shorttextLayoutRows": layout_coverage,
        "shorttextNumericRowsCompared": comparisons["rowsCompared"],
        "shorttextScalarComparisons": comparisons["scalarComparisons"],
        "shorttextMismatches": comparisons["mismatchCount"],
        "shorttextMismatchedPositions": comparisons["mismatchedPositions"],
        "referenceWarnings": len(reference_warnings), "warningCount": len(warnings),
        "tariffPdfPages": len(full_layout.rstrip("\f").split("\f")),
        "shorttextPdfPages": len(short_layout.rstrip("\f").split("\f")),
    }
    return {
        "schemaVersion": 1, "version": "2025.1", "title": "Zahnarzt-Tarif UV/MV/IV (SSO) 2025 mit separat bezeichneten DENTOTAR®-Kurztexten 25.1",
        "sources": sources, "chapters": chapters, "sections": sections, "positions": positions,
        "statistics": statistics, "aliases": aliases, "tariffNotes": tariff_notes,
        "shorttextComparison": comparisons, "warnings": warnings,
        "notices": [
            "Nur persönliche, nichtkommerzielle Referenz. Keine Praxis-, Abrechnungs- oder Softwarelizenz. Die Rechte und Nutzungsbedingungen von SSO und ZMT bleiben vorbehalten.",
            "CHM-Volltext und CHM-Werte sind maßgeblich. DENTOTAR®-Kurztexte sind separat gekennzeichnete Lesetexte; ihre abweichenden Werte ersetzen keine CHM-Angaben.",
            "4.0300: Im CHM fehlt der Sozialversicherungswert; der Kurztext nennt 13.9. Keine Übernahme: seit 2024 nicht zu Lasten UV/MV/IV verrechenbar (MTK-Hinweis).",
            "null bedeutet fehlender bzw. nicht als Taxpunktzahl angegebener Wert, nicht 0. CHF-Beträge stehen separat in amountsCHF; Ausdrücke wie > 0.00 CHF bleiben ausschließlich als Originalangabe in pointTexts erhalten.",
            "Quellenhinweis: D.yyyy nennt im Titel 2.6 % MWST, in der Metadatenzeile aber Normalsatz. Beide Originalangaben werden unverändert beibehalten.",
        ],
    }


def main():
    if len(sys.argv) != 1:
        print("Usage: python3 scripts/import_catalog.py (no arguments)", file=sys.stderr)
        return 2
    try:
        catalog = build_catalog()
        output = ROOT / "public/data"
        output.mkdir(parents=True, exist_ok=True)
        # Serialize before changing outputs; allow_nan=False is a final guard.
        payload = json.dumps(catalog, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        destination = output / "catalog.json"
        destination.write_text(payload, encoding="utf-8")
        shutil.copyfile(ROOT / "sources/sso-uv-mv-iv-2025.pdf", output / "source-tariff.pdf")
        shutil.copyfile(ROOT / "sources/dentotar-kurztext.pdf", output / "source-shorttext.pdf")
        print(f"Generated {destination}")
        print(json.dumps(catalog["statistics"], ensure_ascii=False, indent=2))
        for warning in catalog["warnings"]:
            print(f"WARNING: {warning}", file=sys.stderr)
        print(f"Source mismatches: {catalog['shorttextComparison']['mismatchCount']} fields; full details in shorttextComparison.mismatches")
        return 0
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as exc:
        print(f"Catalog import failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
