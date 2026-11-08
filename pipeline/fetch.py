"""Download every public source into pipeline/cache.

Files that already exist are skipped, so an interrupted run can simply be
restarted. After a game patch run:  py -3.12 pipeline/fetch.py --refresh
"""
import gzip
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(ROOT, "cache")
REFRESH = "--refresh" in sys.argv
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"

AT_MAPS = ["dam-battleground", "the-spaceport", "buried-city", "blue-gate",
           "stella-montis", "riven-tides", "pendola-pass"]
MF_MAPS = ["dam", "spaceport", "buried-city", "blue-gate", "stella-montis",
           "riven-tides", "pendola-pass"]
LOCALES = ["en", "ru", "pl"]
AT = "https://arctracker.io"
CDN = "https://cdn.arctracker.io"
MF = "https://metaforge.app/api"


def get(url, tries=5):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read()
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            time.sleep(5 * (attempt + 1))
        except Exception:
            time.sleep(5 * (attempt + 1))
    return None


def save(url, rel, pause=0.15):
    path = os.path.join(CACHE, rel)
    if os.path.exists(path) and not REFRESH:
        return True
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = get(url)
    if data is None:
        print("MISS", url, flush=True)
        return False
    if path.endswith(".gz"):
        data = gzip.compress(data, 6)
    with open(path, "wb") as fh:
        fh.write(data)
    time.sleep(pause)
    return True


def arctracker():
    save(f"{AT}/api/items", "at/items.json")
    save(f"{AT}/api/quests", "at/quests.json")
    save(f"{AT}/generated/client/items/items-index.en.json", "at/index_en.json")
    for loc in LOCALES:
        save(f"{AT}/generated/client/map-conditions/{loc}.json", f"at/mc_{loc}.json")
    for slug in AT_MAPS:
        for loc in LOCALES:
            suffix = "" if loc == "en" else f".{loc}"
            save(f"{AT}/api/v1/maps/{slug}/pins?locale={loc}&rv=12", f"at/pins_{slug}{suffix}.json")


def metaforge():
    for mid in MF_MAPS:
        save(f"{MF}/game-map-data?tableID=arc_map_data&mapID={mid}", f"mf/mf_map_{mid}.json")
    save(f"{MF}/arc-raiders/arcs?limit=100&includeLoot=true", "mf/mf_arcs.json")
    save(f"{MF}/arc-raiders/items?limit=1000&page=1", "mf/mf_items.json")
    save(f"{MF}/arc-raiders/items?limit=1000&page=2", "mf/mf_items2.json")
    save(f"{MF}/arc-raiders/quests?limit=100&page=1", "mf/mf_quests.json")
    save(f"{MF}/arc-raiders/quests?limit=100&page=2", "mf/mf_quests2.json")


def raidtheory():
    target = os.path.join(CACHE, "rt")
    if os.path.isdir(os.path.join(target, ".git")):
        if REFRESH:
            subprocess.run(["git", "-C", target, "pull", "--depth", "1"], check=False)
    else:
        if os.path.isdir(target):
            shutil.rmtree(target)
        subprocess.run(["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse",
                        "https://github.com/RaidTheory/arcraiders-data", target], check=True)
        subprocess.run(["git", "-C", target, "sparse-checkout", "set", "images"], check=True)
    print("raidtheory ok", flush=True)


def extra_maps():
    for z, qual in ((0, "low"), (1, "low"), (2, "high"), (3, "high")):
        n = 2 ** (z + 1)
        for x in range(n):
            for y in range(n):
                save(f"{CDN}/maps/tiles/pendola-pass/v2/{qual}/{z}/{x}/{y}.webp",
                     f"tiles/pendola-pass/{z}/{x}/{y}.webp", pause=0.05)
    for floor in ("top", "bottom"):
        save(f"{CDN}/maps/stella_montis_{floor}.jpg", f"tiles/stella_{floor}.jpg")
    print("extra maps ok", flush=True)


def icons():
    items = json.load(open(os.path.join(CACHE, "at/items.json"), encoding="utf-8"))["items"]
    miss = 0
    for it in items:
        url = it.get("imageFilename")
        if url and not save(url, f"icons/{it['id']}.png", pause=0.05):
            miss += 1
    print("icons ok, missing", miss, flush=True)


def item_pages():
    items = json.load(open(os.path.join(CACHE, "at/items.json"), encoding="utf-8"))["items"]
    done = 0
    for it in items:
        if not save(f"{AT}/items/{it['id']}", f"at/items/{it['id']}.html.gz", pause=1.0):
            print("page miss", it["id"], flush=True)
        done += 1
        if done % 100 == 0:
            print("pages", done, flush=True)


if __name__ == "__main__":
    arctracker()
    metaforge()
    raidtheory()
    extra_maps()
    icons()
    item_pages()
    print("FETCH DONE", flush=True)
