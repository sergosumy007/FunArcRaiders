# FunArcRaiders

An interactive field guide for the extraction shooter **ARC Raiders**: pick an item, a quest, an ARC robot, a blueprint or a key and see exactly which maps it belongs to and where.

**Live site: https://sergosumy007.github.io/FunArcRaiders/**

The interface is available in **Russian, Polish and English**. Open it from the link above, or download the repository and double-click `docs/index.html`: it works straight from disk, without a server or an internet connection.

## What it does

| Selector | Maps that light up | On the map | In the side panel |
|---|---|---|---|
| **Item** | Every map where it can be found | Containers, robots that drop it, plants and key rooms | How to get it, best areas, crafting |
| **Quest** | Every map it takes place on | Numbered steps and the route between them, with required gear above the map | Step-by-step walkthrough and rewards |
| **ARC robot** | Every map where it spawns | Spawn points and patrol behaviour | Weak points, tactics, suitable weapons and loot |
| **Blueprint** | Every map where it can drop | Matching containers | Conditions, player reports, what it unlocks |
| **Key** | The map with the door it opens | The door | Where the key drops |

Every point carries a confidence label: *exactly here*, *matching container*, *dropped by robot* or *player reports*. Loot in the game is largely random, so the guide says so instead of pretending otherwise.

## How it is built

- **No framework and no backend.** Plain JavaScript and [Leaflet](https://leafletjs.com/) with a custom canvas marker layer, so thousands of points stay smooth.
- **Data loads on demand.** Map points, details and each language arrive only when they are needed.
- **Script tags instead of `fetch`**, which is what allows the site to run from `file://`.
- **A reproducible data pipeline** in `pipeline/`. `fetch.py` downloads the sources, and `build.py` merges them, aligns the coordinate systems by least-squares fitting and generates the site. The build stops with an error if a source changes shape or the alignment degrades.

To refresh the data after a game patch:

```
py -3.12 pipeline/fetch.py --refresh
py -3.12 pipeline/fetch_names.py
py -3.12 pipeline/build.py
```

## Credits

This project stands on the work of the ARC Raiders community:

- [MetaForge](https://metaforge.app/arc-raiders): map markers and game data
- [ARC Tracker](https://arctracker.io): items, quests, loot sources and map pins
- [RaidTheory / arcraiders-data](https://github.com/RaidTheory/arcraiders-data): map tiles and game data
- [ARC Raiders Wiki](https://arcraiders.wiki): robot weak points and tactics
- [ARC Raiders HUB](https://t.me/duckraiders): Russian-language guides and player reports

## Legal

FunArcRaiders is a free, non-commercial fan project. It is not affiliated with, endorsed by or sponsored by Embark Studios AB or Nexon. ARC Raiders and all related names, images and game content are trademarks and copyrights of Embark Studios AB and its licensors. If you are a rights holder and want something removed, please open an issue.

The source code in this repository is released under the MIT License, which does not cover the game content.
