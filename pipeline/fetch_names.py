"""Localized names of containers, ARC robots and map areas (ru/pl/en)."""
import glob
import gzip
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(ROOT, "cache")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
AT = "https://arctracker.io"
MAPS = ["dam-battleground", "the-spaceport", "buried-city", "blue-gate", "stella-montis", "riven-tides", "pendola-pass"]
OUT = os.path.join(CACHE, "at", "names.json")
EXTRA_ARCS = ["wasp", "hornet", "firefly", "snitch", "spotter", "rocketeer", "vaporizer", "arc-turbine", "pop", "fireball", "comet",
              "arc-surveyor", "tick", "shredder", "skulker", "turret", "sentinel", "hydra", "bastion", "bombardier", "leaper", "bully",
              "queen", "matriarch", "arc-frigate", "arc-assessor", "reclaimer", "arc-reclaimer"]


def get(url):
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            time.sleep(5 * (attempt + 1))
        except Exception:
            time.sleep(5 * (attempt + 1))
    return None


def strip(fragment):
    return html.unescape(re.sub(r"<[^>]+>", "", re.sub(r"<svg.*?</svg>", "", fragment, flags=re.S))).strip()


def h1(page):
    m = re.search(r"<h1[^>]*>(.*?)</h1>", page, re.S)
    return strip(m.group(1)) if m else None


def about(page):
    m = re.search(r'<meta name="description" content="([^"]*)"', page)
    return html.unescape(m.group(1)) if m else None


slugs, arcs = set(), set(EXTRA_ARCS)
for path in glob.glob(os.path.join(CACHE, "at", "items", "*.html.gz")):
    page = gzip.decompress(open(path, "rb").read()).decode("utf-8", "replace")
    start = page.find('id="where-to-find"')
    if start < 0:
        continue
    chunk = page[start:start + 60000]
    slugs |= set(re.findall(r'href="/containers/([a-z0-9-]+)"', chunk))
    arcs |= set(re.findall(r'href="/arc/([a-z0-9-]+)"', chunk))
print("containers", len(slugs), "arcs", len(arcs), flush=True)

data = json.load(open(OUT, encoding="utf-8")) if os.path.exists(OUT) else {"cont": {}, "arc": {}, "area": {}, "map": {}}
for loc in ("en", "ru", "pl"):
    prefix = "" if loc == "en" else "/" + loc
    data["cont"].setdefault(loc, {})
    data["arc"].setdefault(loc, {})
    data["area"].setdefault(loc, {})
    data["map"].setdefault(loc, {})
    for slug in sorted(slugs):
        if slug in data["cont"][loc]:
            continue
        page = get(f"{AT}{prefix}/containers/{slug}")
        if page:
            data["cont"][loc][slug] = h1(page)
        time.sleep(0.7)
    for slug in sorted(arcs):
        if slug in data["arc"][loc]:
            continue
        page = get(f"{AT}{prefix}/arc/{slug}")
        if page:
            data["arc"][loc][slug] = {"name": h1(page), "about": about(page)}
        time.sleep(0.7)
    for slug in MAPS:
        page = get(f"{AT}{prefix}/maps/{slug}")
        if not page:
            continue
        nav = re.search(rf'href="{prefix}/maps/{slug}"[^>]*>\s*<span class="arc-nav-label">([^<]+)<', page)
        if nav:
            data["map"][loc][slug] = html.unescape(nav.group(1))
        for area, label in re.findall(rf'href="{prefix}/maps/{slug}\?a=([A-Za-z0-9_]+)"[^>]*>([^<]+)<', page):
            data["area"][loc][f"{slug}/{area}"] = html.unescape(label)
        time.sleep(0.7)
    json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print("names done", loc, flush=True)

img_dir = os.path.join(CACHE, "arcs")
os.makedirs(img_dir, exist_ok=True)
for slug in sorted(arcs):
    path = os.path.join(img_dir, slug + ".webp")
    if os.path.exists(path):
        continue
    try:
        req = urllib.request.Request(f"https://cdn.arctracker.io/arcs/{slug}.webp", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as resp:
            open(path, "wb").write(resp.read())
    except Exception as err:
        print("no image", slug, err, flush=True)
    time.sleep(0.2)
print("NAMES DONE", flush=True)
