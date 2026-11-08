"""Turn pipeline/cache into the static site in docs/.

Run after fetch.py and fetch_names.py:  py -3.12 pipeline/build.py
The build stops with an error when a source changed shape, so a game patch
cannot silently produce an empty or misaligned site.
"""
import collections
import datetime
import glob
import gzip
import html
import json
import os
import re
import shutil
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(ROOT, "cache")
CONTENT = os.path.join(ROOT, "content")
DOCS = os.path.join(os.path.dirname(ROOT), "docs")
DATA = os.path.join(DOCS, "data")
LANGS = ["ru", "pl", "en"]
MAPS = [("dam-battleground", "dam"), ("the-spaceport", "spaceport"), ("buried-city", "buried-city"), ("blue-gate", "blue-gate"),
        ("stella-montis", "stella-montis"), ("riven-tides", "riven-tides"), ("pendola-pass", "pendola-pass")]
QUEST_MAP = {"dam_battlegrounds": "dam-battleground", "the_spaceport": "the-spaceport", "buried_city": "buried-city",
             "the_blue_gate": "blue-gate", "stella_montis": "stella-montis", "stella_montis_upper": "stella-montis",
             "stella_montis_lower": "stella-montis", "riven_tide": "riven-tides", "riven_tides": "riven-tides", "pendola_pass": "pendola-pass"}
RU_MAPS = {"dam-battleground": "Поле битвы у дамбы", "the-spaceport": "Космопорт", "buried-city": "Погребённый город", "blue-gate": "Синие ворота",
           "stella-montis": "Стелла Монтис", "riven-tides": "Бурные потоки", "pendola-pass": "Перевал Пендола"}
ZONES = ["Residential", "ARC", "Commercial", "Exodus", "Security", "Nature", "Mechanical", "Industrial", "Electrical", "Old World", "Medical", "Technological", "Raider"]
RARITY = ["Common", "Uncommon", "Rare", "Epic", "Legendary"]
PEN_ORDER = ["Very Weak", "Weak", "Moderate", "Strong", "Very Strong"]

# Container pages of the source and the pin types that represent them.
AT_SUBTYPE = {"weaponCase": "weapon-case", "ammoCrate": "ammo-crate", "medCrate": "med-crate", "grenadeCrate": "grenade-crate", "weaponRack": "weapon-rack",
              "raiderBackpack": "worn-backpack", "crateCart": "crate-cart", "fruitBasket": "raider-fruit-basket"}
EVENT_SUBTYPE = {"crashedProbe": "arc-probe", "courierWreck": "arc-courier", "dropInLoot": "supply-drop"}
MF_SUBCAT = {"arc_probe": "arc-probe", "arc_courier": "arc-courier", "wasp_husk": "wasp-husk", "rocketeer_husk": "rocketeer-husk", "raider_cache": "raider-cache",
             "hurricane_cache": "raider-cache-first-wave", "frozen_raider_cache": "raider-cache-frozen", "weapon_case": "weapon-case", "ammo_crate": "ammo-crate",
             "med_crate": "med-crate", "breachable_container": "security-locker", "security_breach": "security-locker", "field_crate": "field-crate", "combat_supplies": "combat-supplies"}
MF_NAME_ALIAS = {"car-trunk": "car", "kitchen-cupboard": "kitchen-cabinet", "kitchen-counter": "kitchen-cabinet", "locker": "work-lockers", "transformer": "transformer",
                 "tool-trolley": "tool-trolley", "medical-waste-bin": "medical-waste-bin", "office-desk": "office-desk", "bus": "bus", "fridge": "fridge"}
NATURE_ALIAS = {"lemon": "lemons", "olives": "olives", "prickly_pear": "prickly_pear"}
HINTS = [("map", "stella-montis", None, ["Афелий", "Дедлайн", "Импульсная мина", "Зажигалка", "Самонаводящаяся граната", "Газовая мина"], "t.me/duckraiders/1415"),
         ("cond", "harvester", "puzzle", ["Уравнитель", "Юпитер"], "t.me/duckraiders/1417"),
         ("cond", "electromagnetic-storm", None, ["Крюк с защёлкой", "Токовая катушка"], "t.me/duckraiders/1420"),
         ("cond", "night-raid", None, ["Буря", "Волчья Стая"], "t.me/duckraiders/1421"),
         ("cond", "locked-gate", None, ["Рысь"], "t.me/duckraiders/17502"),
         ("cond", "hidden-bunker", None, ["Вулкан"], "t.me/duckraiders/17505"),
         ("cond", "cold-snap", None, ["Коробка с фейерверками"], "t.me/duckraiders/31603"),
         ("cond", "hurricane", "firstwave", ["Буря", "Вулкан", "Рысь"], "t.me/duckraiders/65769")]
HINT_TEXT = {"ru": {"map": "Находили на карте: {}", "cond": "Находили при условии: {}", "puzzle": "Внутри Сборщика, если решить пазл", "firstwave": "В тайниках Первой волны"},
             "pl": {"map": "Znajdowano na mapie: {}", "cond": "Znajdowano przy warunku: {}", "puzzle": "Wewnątrz Żniwiarza po rozwiązaniu zagadki", "firstwave": "W skrytkach Pierwszej Fali"},
             "en": {"map": "Found on the map: {}", "cond": "Found during: {}", "puzzle": "Inside the Harvester after solving its puzzle", "firstwave": "In First Wave caches"}}


def load(rel):
    with open(os.path.join(CACHE, rel), encoding="utf-8") as fh:
        return json.load(fh)


def load_content(name):
    with open(os.path.join(CONTENT, name), encoding="utf-8") as fh:
        return json.load(fh)


def norm(text):
    return str(text).strip().lower().replace("-", "_")


def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")


def squash(text):
    return re.sub(r"[^a-z0-9]", "", str(text).lower())


def js(name, payload, var):
    os.makedirs(DATA, exist_ok=True)
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(DATA, name), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(f"{var}={body};\n")
    return len(body)


def round1(value):
    return round(float(value), 1)


# ---------------------------------------------------------------- calibration


def calibrate(slug, pins, markers):
    """Least-squares axis-aligned fit of MetaForge coordinates onto the tile space."""
    at_types, mf_types = collections.defaultdict(list), collections.defaultdict(list)
    for p in pins:
        if p.get("lat") is not None and p.get("subtype"):
            at_types[squash(p["subtype"])].append((p["lng"], p["lat"]))
    for m in markers:
        mf_types[squash(m["subcategory"])].append((m["lng"], m["lat"]))
    shared = [k for k in at_types if k in mf_types and len(at_types[k]) >= 4 and len(mf_types[k]) >= 4]
    if len(shared) < 5:
        raise SystemExit(f"calibration: too few shared point types on {slug}: {shared}")
    a = np.array([q for k in shared for q in at_types[k]], float)
    b = np.array([q for k in shared for q in mf_types[k]], float)
    la = np.array([i for i, k in enumerate(shared) for _ in at_types[k]])
    lb = np.array([i for i, k in enumerate(shared) for _ in mf_types[k]])
    best = None
    for sx in (1, -1):
        for sy in (1, -1):
            ax = sx * np.ptp(a[:, 0]) / np.ptp(b[:, 0])
            ay = sy * np.ptp(a[:, 1]) / np.ptp(b[:, 1])
            bx = np.median(a[:, 0]) - ax * np.median(b[:, 0])
            by = np.median(a[:, 1]) - ay * np.median(b[:, 1])
            dist = None
            for it in range(40):
                moved = np.c_[b[:, 0] * ax + bx, b[:, 1] * ay + by]
                dist = np.full(len(a), 1e9)
                near = np.zeros(len(a), int)
                for c in range(len(shared)):
                    ia, ib = np.where(la == c)[0], np.where(lb == c)[0]
                    d2 = ((a[ia][:, None, :] - moved[ib][None, :, :]) ** 2).sum(2)
                    k = d2.argmin(1)
                    dist[ia] = np.sqrt(d2[np.arange(len(ia)), k])
                    near[ia] = ib[k]
                keep = dist <= (max(np.percentile(dist, 60), 0.6) if it > 4 else np.percentile(dist, 80))
                if keep.sum() < 8:
                    break
                ax, bx = np.polyfit(b[near[keep], 0], a[keep, 0], 1)
                ay, by = np.polyfit(b[near[keep], 1], a[keep, 1], 1)
            score = float((dist < 1.5).mean())
            if best is None or score > best[0]:
                best = (score, float(np.median(dist)), ax, bx, ay, by)
    if best[0] < 0.6 or best[1] > 1.5:
        raise SystemExit(f"calibration failed on {slug}: inliers {best[0]:.2f}, median {best[1]:.2f}")
    print(f"  calibrated {slug}: inliers {best[0]:.3f}, median offset {best[1]:.3f}")
    return best[2:]


# ---------------------------------------------------------------- item pages


def parse_item_page(item_id):
    path = os.path.join(CACHE, "at", "items", item_id + ".html.gz")
    empty = {"cont": [], "drop": [], "best": [], "maps": set(), "quests": [], "traders": [], "trials": False}
    if not os.path.exists(path):
        return empty
    page = gzip.decompress(open(path, "rb").read()).decode("utf-8", "replace")
    start = page.find('id="where-to-find"')
    if start < 0:
        return empty
    end_match = re.search(r'class="arc-card-title">(?!Where to find)', page[start + 40:])
    block = page[start: start + 40 + end_match.start()] if end_match else page[start: start + 60000]
    out = dict(empty, maps=set())
    out["cont"], out["drop"], out["best"], out["quests"], out["traders"] = [], [], [], [], []
    cut = re.search(r'id="where-to-find-containers"', block)
    if cut:
        section = block[cut.start():]
        stop = re.search(r'id="where-to-find-(?!containers)[a-z-]+"', section)
        section = section[:stop.start()] if stop else section
        for row in section.split('class="arc-lootrow"')[1:]:
            slug = re.search(r'href="/containers/([a-z0-9-]+)"', row)
            if slug:
                events = re.search(r'data-only-events="([^"]+)"', row)
                out["cont"].append({"s": slug.group(1), "ev": events.group(1).split() if events else []})
    out["drop"] = sorted(set(re.findall(r'href="/arc/([a-z0-9-]+)"', block)))
    out["quests"] = sorted(set(re.findall(r'href="/quests/([a-z0-9-]+)"', block)))
    out["traders"] = sorted(set(re.findall(r'href="/traders/([a-z0-9-]+)"', block)))
    out["trials"] = "where-to-find-trials" in block
    out["maps"] = set(re.findall(r'href="/maps/([a-z-]+)\?i=', block))
    seen = set()
    anchors = list(re.finditer(r'href="/maps/([a-z-]+)\?i=[^"&]+&amp;a=([A-Za-z0-9_]+)"', block))
    for i, m in enumerate(anchors):
        key = (m.group(1), m.group(2))
        if key in seen:
            continue
        seen.add(key)
        row = block[m.start(): anchors[i + 1].start() if i + 1 < len(anchors) else m.start() + 2500]
        text = html.unescape(re.sub(r"<[^>]+>", "|", re.sub(r"<svg.*?</svg>", "", row, flags=re.S)))
        tier = re.search(r'data-tier="(\d)"', row)
        out["best"].append({"m": m.group(1), "a": m.group(2), "t": int(tier.group(1)) if tier else 0,
                            "z": [z for z in ZONES if re.search(r"\|\s*" + re.escape(z) + r"\s*\|", text)]})
    return out


# ---------------------------------------------------------------- tiles & images


def copy_tree(src, dst):
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def build_tiles():
    tiles = os.path.join(DOCS, "tiles")
    rt = os.path.join(CACHE, "rt", "images", "maps")
    native = {}
    for slug, _ in MAPS:
        if slug == "stella-montis":
            continue
        dst = os.path.join(tiles, slug)
        if slug == "pendola-pass":
            copy_tree(os.path.join(CACHE, "tiles", "pendola-pass"), dst)
        else:
            if os.path.isdir(dst):
                shutil.rmtree(dst)
            for qual in ("low", "high"):
                base = os.path.join(rt, slug, "v2", qual)
                for z in os.listdir(base):
                    if z.isdigit():
                        shutil.copytree(os.path.join(base, z), os.path.join(dst, z))
        native[slug] = max(int(z) for z in os.listdir(dst) if z.isdigit())
    for floor in ("top", "bottom"):
        img = Image.open(os.path.join(CACHE, "tiles", f"stella_{floor}.jpg")).convert("RGB")
        if abs(img.width / img.height - 1) > 0.02:
            raise SystemExit(f"Stella {floor} image is not square: {img.size}")
        dst = os.path.join(tiles, f"stella-montis-{floor}")
        if os.path.isdir(dst):
            shutil.rmtree(dst)
        top = 0
        while 1000 * 2 ** (top + 1) <= img.width * 1.15 and top < 3:
            top += 1
        for z in range(top + 1):
            size = 1000 * 2 ** z
            scaled = img.resize((size, size), Image.LANCZOS)
            count = int(np.ceil(size / 512))
            for x in range(count):
                for y in range(count):
                    tile = Image.new("RGB", (512, 512), (12, 11, 8))
                    tile.paste(scaled.crop((x * 512, y * 512, min(size, (x + 1) * 512), min(size, (y + 1) * 512))), (0, 0))
                    out = os.path.join(dst, str(z), str(x))
                    os.makedirs(out, exist_ok=True)
                    tile.save(os.path.join(out, f"{y}.webp"), "WEBP", quality=80, method=4)
        native["stella-montis"] = top
    thumbs = os.path.join(DOCS, "img", "maps")
    os.makedirs(thumbs, exist_ok=True)
    for slug, _ in MAPS:
        src = os.path.join(tiles, slug if slug != "stella-montis" else "stella-montis-top", "0")
        sheet = Image.new("RGB", (1024, 1024), (12, 11, 8))
        for x in range(2):
            for y in range(2):
                sheet.paste(Image.open(os.path.join(src, str(x), f"{y}.webp")).convert("RGB"), (x * 512, y * 512))
        sheet.crop((90, 90, 910, 910)).resize((140, 140), Image.LANCZOS).save(os.path.join(thumbs, slug + ".webp"), "WEBP", quality=74, method=5)
    return native


def build_icons(ids):
    out = os.path.join(DOCS, "img", "items")
    os.makedirs(out, exist_ok=True)
    miss = 0
    for item_id in ids:
        src = os.path.join(CACHE, "icons", item_id + ".png")
        dst = os.path.join(out, item_id + ".webp")
        if os.path.exists(dst):
            continue
        if not os.path.exists(src):
            miss += 1
            continue
        img = Image.open(src).convert("RGBA")
        img.thumbnail((96, 96), Image.LANCZOS)
        img.save(dst, "WEBP", quality=78, method=4)
    arcs = os.path.join(DOCS, "img", "arcs")
    os.makedirs(arcs, exist_ok=True)
    for path in glob.glob(os.path.join(CACHE, "arcs", "*.webp")):
        name = os.path.basename(path)
        img = Image.open(path).convert("RGBA")
        img.thumbnail((128, 128), Image.LANCZOS)
        img.save(os.path.join(arcs, name), "WEBP", quality=78, method=4)
    print("  icons missing:", miss)


# ---------------------------------------------------------------- main


def main():
    items = load("at/items.json")["items"]
    item_ids = {x["id"] for x in items}
    index = {x["id"]: x for x in load("at/index_en.json")["items"]}
    quests = load("at/quests.json")["quests"]
    conditions = {loc: load(f"at/mc_{loc}.json")["conditions"] for loc in LANGS}
    names = load("at/names.json")
    arcs_text = load_content("arcs.json")
    ui = load_content("ui.json")
    mf_items = load("mf/mf_items.json")["data"] + load("mf/mf_items2.json")["data"]
    quest_by_slug = {q.get("slug"): qid for qid, q in quests.items() if q.get("slug")}

    # ARC ids used by the site are the source slugs; "arc-assessor" etc. are normalised below.
    arc_alias = {"arc-assessor": "assessor", "arc-reclaimer": "reclaimer", "arc-frigate": "arc-frigate"}
    canon_arc = lambda slug: arc_alias.get(slug, slug)

    print("parsing item pages")
    where = {x["id"]: parse_item_page(x["id"]) for x in items}
    known_slugs = {c["s"] for w in where.values() for c in w["cont"]}

    per_map = {}
    print("building map layers")
    mf_slug_used = collections.Counter()
    unmatched = collections.Counter()
    for slug, mf_id in MAPS:
        pins = load(f"at/pins_{slug}.json")["data"]["pins"]
        markers = load(f"mf/mf_map_{mf_id}.json")["allData"]
        ax, bx, ay, by = calibrate(slug, pins, markers)
        project = lambda m: (round1(m["lng"] * ax + bx), round1(m["lat"] * ay + by))
        floor_of = lambda p: 1 if str(p.get("floor")).strip('"') == "bottom" else 0
        layer = {"C": collections.defaultdict(list), "N": collections.defaultdict(list), "A": collections.defaultdict(list),
                 "Q": collections.defaultdict(list), "K": collections.defaultdict(list), "B": {}, "L": []}
        label_rows, quest_tools = [], collections.defaultdict(list)
        at_conts = set()

        def add_cont(name, x, y, f):
            layer["C"][name] += [x, y, f]

        for p in pins:
            if p.get("lat") is None:
                continue
            x, y, f, kind, sub = round1(p["lng"]), round1(p["lat"]), floor_of(p), p.get("kind"), p.get("subtype")
            tags = p.get("tags") or []
            if p.get("origin") == "community":
                ft = {"text-region": "r", "text-landmark": "l"}.get(p.get("featureType"))
                if ft:
                    label_rows.append((x, y, ft, p["ref"], p.get("title")))
                continue
            if kind == "nature":
                for t in tags:
                    if t.startswith("gives:"):
                        give = t[6:]
                        give = give if give in item_ids else NATURE_ALIAS.get(give, give)
                        layer["N"][give] += [x, y, f]
                        add_cont(slugify(give), x, y, f)
                continue
            if kind == "container" or (kind == "event" and sub in EVENT_SUBTYPE) or (kind == "carryable" and sub == "fieldCrate"):
                name = EVENT_SUBTYPE.get(sub) or AT_SUBTYPE.get(sub)
                if sub == "raiderCache":
                    name = "raider-cache-first-wave" if "firstWave" in tags else "raider-cache-frozen" if ("frozen" in tags or "coldSnap" in tags) else "raider-cache-rigged" if "selfDestruct" in tags else "raider-cache"
                if sub == "fruitBasket" and ("winter" in tags or "coldSnap" in tags):
                    name = "raider-fruit-basket-winter"
                if sub == "fieldCrate":
                    name = "field-crate"
                if name:
                    add_cont(name, x, y, f)
                    at_conts.add(name)
                else:
                    unmatched["pin:" + str(sub)] += 1
                continue
            if kind == "arc" and sub == "husk":
                odds = " ".join(o.get("parent", "") for o in p.get("odds") or [])
                add_cont("rocketeer-husk" if "Rocketeer" in odds else "wasp-husk" if "Wasp" in odds else "arc-husk-pile", x, y, f)
                continue
            if kind == "arc" and sub == "assessor":
                layer["A"]["assessor"] += [x, y, f, 0]
                add_cont("arc-assessor", x, y, f)
                continue
            if kind == "event" and sub in ("frigatePose", "frigatePath", "frigateDropsite", "frigateBeacon"):
                layer["A"]["arc-frigate"] += [x, y, f, 0]
                continue
            enemies = p.get("enemies") or {}
            if enemies.get("lead") or enemies.get("escort"):
                mv = {"static-point": 0, "spline-patrol": 1, "snap-slots": 2, "frigate": 3}.get(enemies.get("movement"), 0)
                for a in enemies.get("lead") or []:
                    layer["A"][canon_arc(a)] += [x, y, f, mv << 1]
                for a in enemies.get("escort") or []:
                    layer["A"][canon_arc(a)] += [x, y, f, (mv << 1) | 1]
            for req in p.get("requiredItems") or []:
                if req.get("role") == "key" and req.get("itemId") in item_ids:
                    layer["K"][req["itemId"]] += [x, y, f]
            links = p.get("questLinks") or []
            if kind == "quest" or links:
                spots = p.get("spots") or [[p["lat"], p["lng"]]]
                for link in links:
                    if link.get("role") == "related":
                        continue
                    for lat, lng in spots:
                        layer["Q"][link["questId"]].append([round1(lng), round1(lat), link.get("objectiveIndex"), link.get("role"), f])
                for req in p.get("requiredItems") or []:
                    for link in links:
                        if req.get("itemId") in item_ids:
                            quest_tools[link["questId"]].append(req["itemId"])

        for m in markers:
            x, y = project(m)
            f = 1 if (mf_id == "stella-montis" and m.get("zlayers") == 1) else 0
            cat, sub = m["category"], m["subcategory"]
            if cat == "containers":
                name = None
                inst = slugify(m.get("instanceName") or "")
                inst = MF_NAME_ALIAS.get(inst, inst)
                if inst in known_slugs:
                    name = inst
                elif sub in MF_SUBCAT:
                    name = MF_SUBCAT[sub]
                if name and name not in at_conts:
                    add_cont(name, x, y, f)
                    mf_slug_used[name] += 1
                elif not name:
                    unmatched["mf:" + (inst or sub)] += 1
            elif cat == "quests":
                qid = quest_by_slug.get(sub)
                if qid and not any(r for r in layer["Q"].get(qid, []) if r[2] is not None):
                    layer["Q"][qid].append([x, y, None, "mf", f])

        # Spotters fly with Bombardiers and have no spawn points of their own.
        if layer["A"].get("bombardier"):
            layer["A"]["spotter"] = list(layer["A"]["bombardier"])
        per_map[slug] = {"layer": layer, "labels": label_rows, "quest_tools": quest_tools}

    print("  containers from MF:", sum(mf_slug_used.values()), "unmatched top:", unmatched.most_common(12))
    missing = sorted(s for s in known_slugs if not any(s in pm["layer"]["C"] for pm in per_map.values()) and not s.startswith("arc-remains"))
    print("  container slugs with no points:", len(missing), missing[:40])

    # Key rooms named by MetaForge item locations.
    for it in mf_items:
        iid = norm(it["id"])
        if iid not in item_ids:
            continue
        for loc in it.get("locations") or []:
            target = next((s for s, mf in MAPS if mf == loc.get("map")), None)
            if target and iid not in per_map[target]["layer"]["K"]:
                markers = load(f"mf/mf_map_{loc['map']}.json")["allData"]
                hit = next((m for m in markers if m["id"] == loc.get("id")), None)
                if hit:
                    pins = load(f"at/pins_{target}.json")["data"]["pins"]
                    ax, bx, ay, by = calibrate(target, pins, markers)
                    per_map[target]["layer"]["K"][iid] += [round1(hit["lng"] * ax + bx), round1(hit["lat"] * ay + by), 0]

    # Remains of a robot appear where the robot does.
    arc_of_remains = {"arc-remains-" + a: a for a in ("bastion", "bombardier", "sentinel", "matriarch", "queen", "surveyor", "turbine", "comet", "vaporizer", "rocketeer", "leaper", "shredder", "hornet", "wasp")}
    alias_remains = {"surveyor": "arc-surveyor", "turbine": "arc-turbine"}

    # Items and blueprints
    item_details, core_items = {}, []
    names_ru = {x["name"]["ru"]: x["id"] for x in items if x.get("type") == "Blueprint"}
    hint_for = collections.defaultdict(list)
    for kind, where_id, extra, wanted, source in HINTS:
        for want in wanted:
            found = next((iid for ru, iid in names_ru.items() if want.lower().replace("ё", "е") in ru.lower().replace("ё", "е")), None)
            if not found:
                print("  hint without blueprint:", want)
                continue
            hint_for[found].append((kind, where_id, extra, source))
    print("  blueprints with player reports:", len(hint_for))

    reverse_drop = collections.defaultdict(set)
    for x in items:
        w = where[x["id"]]
        iid = x["id"]
        drops = sorted({canon_arc(a) for a in w["drop"]})
        for a in drops:
            reverse_drop[a].add(iid)
        counts = collections.Counter()
        for slug, _ in MAPS:
            layer = per_map[slug]["layer"]
            n = len(layer["N"].get(iid, [])) // 3 + len(layer["K"].get(iid, [])) // 3
            for c in w["cont"]:
                raw = layer["C"].get(c["s"])
                if raw is None and c["s"] in arc_of_remains:
                    a = arc_of_remains[c["s"]]
                    n += len(layer["A"].get(alias_remains.get(a, a), [])) // 4
                elif raw:
                    n += len(raw) // 3
            for a in drops:
                n += len(layer["A"].get(a, [])) // 4
            if n:
                counts[slug] = n
            elif slug in w["maps"]:
                counts[slug] = 1
        for kind, where_id, _, _ in hint_for.get(iid, []):
            if kind == "map" and not counts[where_id]:
                counts[where_id] = 1
        det = {}
        conts = []
        for c in w["cont"]:
            if c["s"] in arc_of_remains:
                continue
            conts.append({"s": c["s"], **({"ev": c["ev"]} if c["ev"] else {})})
        if conts:
            det["cont"] = conts
        if drops:
            det["drop"] = drops
        if w["best"]:
            det["best"] = sorted(w["best"], key=lambda b: -b["t"])[:8]
        rew = [quest_by_slug[q] for q in w["quests"] if q in quest_by_slug]
        if rew:
            det["rew"] = rew
        if w["traders"]:
            det["vend"] = [t.replace("-", " ").title() for t in w["traders"]]
        if w["trials"]:
            det["trials"] = 1
        if x.get("recipe"):
            det["craft"] = {k: v for k, v in x["recipe"].items() if k in item_ids}
        entry = {"id": iid, "t": x.get("type"), "r": x.get("rarity")}
        if x.get("type") == "Blueprint":
            entry["bp"] = 1
            target = (index.get(iid) or {}).get("targetItemId")
            if target in item_ids:
                det["unlocks"] = target
            if iid in hint_for:
                det["hints"] = 1
        if counts:
            entry["c"] = dict(counts)
        core_items.append(entry)
        if det:
            item_details[iid] = det

    # Quests
    core_quests, quest_details = [], {}
    for qid, q in quests.items():
        counts = collections.Counter()
        for slug, _ in MAPS:
            n = len(per_map[slug]["layer"]["Q"].get(qid, []))
            if n:
                counts[slug] = n
        for raw in q.get("map") or []:
            target = QUEST_MAP.get(raw)
            if not target:
                raise SystemExit(f"unknown quest map {raw}")
            if not counts[target]:
                counts[target] = 1
        tools = sorted({t for slug, _ in MAPS for t in per_map[slug]["quest_tools"].get(qid, [])})
        req_ids = {r["itemId"] for r in q.get("requiredItemIds") or []}
        det = {"trader": q.get("trader")}
        det["req"] = [{"i": r["itemId"], "q": r.get("quantity", 1), **({"qi": 1} if r.get("questItem") else {})} for r in q.get("requiredItemIds") or [] if r["itemId"] in item_ids]
        det["tools"] = [{"i": t, "q": 1} for t in tools if t not in req_ids]
        det["rew"] = [{"i": r["itemId"], "q": r.get("quantity", 1)} for r in q.get("rewardItemIds") or [] if r.get("itemId") in item_ids]
        det["prev"] = [p for p in q.get("previousQuestIds") or [] if p in quests]
        det["next"] = [p for p in q.get("nextQuestIds") or [] if p in quests]
        if q.get("videoUrl"):
            det["video"] = q["videoUrl"]
        entry = {"id": qid, "tr": q.get("trader") or ""}
        if counts:
            entry["c"] = dict(counts)
        core_quests.append(entry)
        quest_details[qid] = det

    # ARC robots
    def by_name(english):
        wanted = squash(english)
        hit = [x["id"] for x in items if wanted in squash(x["name"].get("en", "")) and x.get("type") != "Blueprint"]
        if not hit:
            raise SystemExit(f"gear item not found: {english}")
        return sorted(hit, key=len)[0]

    pen_values = collections.Counter()
    weapons = []
    for x in items:
        if not x.get("isWeapon") or not re.search(r"_i$", x["id"]):
            continue
        value = ((x.get("effects") or {}).get("ARC Armor Penetration") or {}).get("value")
        if value:
            pen_values[value] += 1
            weapons.append((x["id"], value, x.get("rarity")))
    unknown = set(pen_values) - set(PEN_ORDER)
    if unknown:
        raise SystemExit(f"unknown armour penetration values: {unknown}")
    print("  weapons:", len(weapons), dict(pen_values))
    core_arcs, arc_details = [], {}
    for aid, info in arcs_text.items():
        counts = collections.Counter()
        for slug, _ in MAPS:
            n = len(per_map[slug]["layer"]["A"].get(aid, [])) // 4
            if n:
                counts[slug] = n
        floor_need = info["need"] + 1 if info["need"] else 0
        pool = [w for w in weapons if PEN_ORDER.index(w[1]) + 0 >= floor_need]
        pool.sort(key=lambda w: (RARITY.index(w[2]) if w[2] in RARITY else 9, PEN_ORDER.index(w[1])))
        loot = sorted(reverse_drop.get(aid, []), key=lambda i: -RARITY.index(next((x.get("rarity") for x in items if x["id"] == i), "Common")))
        det = {"weapons": [w[0] for w in pool[:6]], "gear": [by_name(g) for g in info["gear"]], "loot": loot[:14]}
        entry = {"id": aid, "th": info["threat"]}
        if counts:
            entry["c"] = dict(counts)
        core_arcs.append(entry)
        arc_details[aid] = det

    # Files
    if os.path.isdir(DATA):
        shutil.rmtree(DATA)
    print("building tiles and icons")
    native = build_tiles()
    build_icons([x["id"] for x in items])
    core_maps = [{"id": s, "native": native[s], **({"floors": ["top", "bottom"]} if s == "stella-montis" else {})} for s, _ in MAPS]
    built = datetime.date.today().isoformat()
    size = js("core.js", {"built": built, "maps": core_maps, "items": core_items, "quests": core_quests, "arcs": core_arcs}, "window.FAR={core:null,i18n:{},details:{},mapdata:{}};FAR.core")
    print("  core", size)
    js("details.items.js", item_details, "FAR.details.items")
    js("details.quests.js", quest_details, "FAR.details.quests")
    js("details.arcs.js", arc_details, "FAR.details.arcs")

    label_text = {}
    for slug, _ in MAPS:
        pack = per_map[slug]
        keep = []
        trans = {}
        for loc in LANGS:
            suffix = "" if loc == "en" else f".{loc}"
            trans[loc] = {p["ref"]: p.get("title") for p in load(f"at/pins_{slug}{suffix}.json")["data"]["pins"] if p.get("origin") == "community"}
        for x, y, ft, ref, title in pack["labels"]:
            keep.append([x, y, ft])
            for loc in LANGS:
                label_text.setdefault(loc, {}).setdefault(slug, []).append(trans[loc].get(ref) or title)
        layer = pack["layer"]
        layer["L"] = keep
        area_points = {}
        area_names = {k.split("/", 1)[1]: v for k, v in names["area"].get("en", {}).items() if k.startswith(slug + "/")}
        labels_by_title = {squash(t): (x, y) for x, y, _, _, t in pack["labels"] if t}
        for area, title in area_names.items():
            base = squash(re.sub(r"\(.*?\)", "", title))
            hit = labels_by_title.get(base) or next((v for k, v in labels_by_title.items() if len(k) > 5 and (k in base or base in k)), None)
            if hit:
                area_points[area] = [hit[0], hit[1]]
        layer["B"] = area_points
        print(f"  {slug}: areas placed {len(area_points)}/{len(area_names)}")
        js(f"map.{slug}.js", {k: (dict(v) if isinstance(v, collections.defaultdict) else v) for k, v in layer.items()}, f"FAR.mapdata[{json.dumps(slug)}]")

    for li, loc in enumerate(LANGS):
        names_block = {"item": {}, "quest": {}, "arc": {}, "map": {}, "cont": {}, "area": {}, "cond": {}}
        text = {"item": {}, "quest": {}, "arc": {}}
        for x in items:
            names_block["item"][x["id"]] = (x.get("name") or {}).get(loc) or x["name"]["en"]
            desc = (x.get("description") or {}).get(loc)
            if desc:
                text["item"][x["id"]] = desc
        for qid, q in quests.items():
            names_block["quest"][qid] = (q.get("name") or {}).get(loc) or q["name"]["en"]
            text["quest"][qid] = {"d": (q.get("description") or {}).get(loc) or "", "o": [(o.get(loc) or o.get("en") or "") for o in q.get("objectives") or []]}
        for aid, info in arcs_text.items():
            slug = {"assessor": "arc-assessor", "reclaimer": "arc-reclaimer"}.get(aid, aid)
            rec = (names["arc"].get(loc) or {}).get(slug) or (names["arc"]["en"].get(slug) or {})
            names_block["arc"][aid] = rec.get("name") or (names["arc"]["en"].get(slug) or {}).get("name") or aid.replace("-", " ").title()
            text["arc"][aid] = {"about": rec.get("about") or "", "weak": info["weak"][loc], "tactic": info["tactic"][loc]}
        for slug, _ in MAPS:
            names_block["map"][slug] = RU_MAPS[slug] if loc == "ru" else (names["map"].get(loc) or {}).get(slug) or slug
        for slug, nm in (names["cont"].get(loc) or {}).items():
            names_block["cont"][slug] = nm or (names["cont"]["en"].get(slug)) or slug
        for slug in {s for pm in per_map.values() for s in pm["layer"]["C"]} - set(names_block["cont"]):
            names_block["cont"][slug] = names["cont"]["en"].get(slug) or slug.replace("-", " ").title()
        names_block["area"] = {**names["area"]["en"], **(names["area"].get(loc) or {})}
        for cid, cond in conditions[loc].items():
            names_block["cond"][cid] = cond["name"].strip("«»")
        hints_text = {}
        for iid, rows in hint_for.items():
            lines = []
            for kind, where_id, extra, _ in rows:
                label = names_block["map"][where_id] if kind == "map" else names_block["cond"].get(where_id, where_id)
                line = HINT_TEXT[loc][kind].format(label)
                if extra:
                    line += ". " + HINT_TEXT[loc][extra]
                lines.append(line)
            hints_text[iid] = lines
        en_search = {}
        if loc != "en":
            for x in items:
                en_search["item:" + x["id"]] = x["name"]["en"]
            for qid, q in quests.items():
                en_search["quest:" + qid] = q["name"]["en"]
            for aid in arcs_text:
                slug = {"assessor": "arc-assessor", "reclaimer": "arc-reclaimer"}.get(aid, aid)
                en_search["arc:" + aid] = (names["arc"]["en"].get(slug) or {}).get("name") or aid
        payload = {"ui": ui[loc], "types": {k: v[li] for k, v in ui["types"].items()}, "rarity": {k: v[li] for k, v in ui["rarity"].items()},
                   "threats": {k: v[li] for k, v in ui["threats"].items()}, "zones": {k: v[li] for k, v in ui["zones"].items()},
                   "names": names_block, "text": text, "hints": hints_text, "labels": label_text.get(loc, {}), "en": en_search}
        print(f"  i18n {loc}", js(f"i18n.{loc}.js", payload, f"FAR.i18n.{loc}"))

    # Summary the release checks read.
    summary = {"items": len(core_items), "items_on_maps": sum(1 for e in core_items if e.get("c")), "blueprints": sum(1 for e in core_items if e.get("bp")),
               "blueprints_on_maps": sum(1 for e in core_items if e.get("bp") and e.get("c")), "quests": len(core_quests), "quests_on_maps": sum(1 for e in core_quests if e.get("c")),
               "quests_with_steps_on_map": sum(1 for q in quests if any(any(r[2] is not None for r in per_map[s]["layer"]["Q"].get(q, [])) for s, _ in MAPS)),
               "arcs": len(core_arcs), "arcs_on_maps": sum(1 for e in core_arcs if e.get("c")), "points": sum(sum(len(v) // 3 for v in pm["layer"]["C"].values()) for pm in per_map.values())}
    print("SUMMARY", json.dumps(summary, ensure_ascii=False))
    print("arcs without points:", [e["id"] for e in core_arcs if not e.get("c")])


if __name__ == "__main__":
    main()
