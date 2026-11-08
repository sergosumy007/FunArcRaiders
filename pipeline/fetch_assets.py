"""Bundle Leaflet and the web fonts so the site works without any CDN."""
import os
import re
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(os.path.dirname(ROOT), "docs")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
FONTS = "https://fonts.googleapis.com/css2?family=Unbounded:wght@700;800&family=Sofia+Sans+Extra+Condensed:wght@600;700;800&family=Golos+Text:wght@400;500;600;700&display=swap"
KEEP = {"cyrillic", "cyrillic-ext", "latin", "latin-ext"}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


vendor = os.path.join(DOCS, "vendor")
os.makedirs(vendor, exist_ok=True)
for name in ("leaflet.js", "leaflet.css"):
    open(os.path.join(vendor, name), "wb").write(get(f"https://unpkg.com/leaflet@1.9.4/dist/{name}"))

fonts = os.path.join(DOCS, "fonts")
os.makedirs(fonts, exist_ok=True)
css = get(FONTS).decode("utf-8")
out, n = [], 0
for subset, block in re.findall(r"/\* ([a-z-]+) \*/\s*(@font-face \{.*?\})", css, re.S):
    if subset not in KEEP:
        continue
    url = re.search(r"url\((https://[^)]+\.woff2)\)", block).group(1)
    family = re.search(r"font-family: '([^']+)'", block).group(1).replace(" ", "")
    weight = re.search(r"font-weight: (\d+)", block).group(1)
    name = f"{family}-{subset}-{weight}.woff2"
    target = os.path.join(fonts, name)
    if not os.path.exists(target):
        open(target, "wb").write(get(url))
    out.append(block.replace(url, name))
    n += 1
open(os.path.join(fonts, "fonts.css"), "w", encoding="utf-8").write("\n".join(out) + "\n")
print("fonts", n)
