from pathlib import Path
from urllib.request import Request, urlopen
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
FILES = {
    'sso-uv-mv-iv-2025.pdf': 'https://www.mtk-ctm.ch/download_file/e0700c53-f6bc-4f35-a440-3d446503a951/463',
    'sso-uv-mv-iv-2025.chm': 'https://www.mtk-ctm.ch/download_file/87d99191-6ebc-47f4-a05e-04efab77c9f4/463',
    'dentotar-kurztext.pdf': 'https://www.sso.ch/de/media/4457/download?attachment',
    'tarifbrowser-merkblatt.pdf': 'https://www.mtk-ctm.ch/download_file/476dd306-e176-45e3-bd2e-d620fd0fed32/463',
}

def main():
    target = ROOT / 'sources'
    target.mkdir(exist_ok=True)
    records = []
    for name, url in FILES.items():
        request = Request(url, headers={'User-Agent': 'DentotarPersonalBrowser/0.1'})
        with urlopen(request, timeout=90) as response:
            data = response.read()
        expected = b'%PDF-' if name.endswith('.pdf') else b'ITSF'
        if not data.startswith(expected):
            raise ValueError(f'{name}: unexpected response format')
        (target / name).write_bytes(data)
        record = {'file': name, 'url': url, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        records.append(record)
        print(json.dumps(record))
    (target / 'downloads.json').write_text(json.dumps(records, indent=2), encoding='utf-8')

if __name__ == '__main__':
    main()
