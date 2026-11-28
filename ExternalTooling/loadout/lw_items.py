"""Données Leek Wars : armes, puces et poireau, lus sur l'API publique (aucune clé requise).

Hors ligne de la partie combat : ce module ne touche ni à `src/` ni à Garden. Réponses mises en cache dans
`ExternalTooling/loadout/.cache/` (ignoré par Git) ; `--refresh` les refait.

Pool d'items (`pool_items`) : `level` = tout ce que le niveau du poireau permet d'acheter, `all` = tout le jeu,
`owned` = la liste fournie par `--owned-file` (JSON {"weapons": [noms], "chips": [noms]}) ou lue sur le compte avec
les variables d'environnement LW_LOGIN / LW_PASSWORD (jamais écrites sur disque).
"""
from __future__ import annotations

import json
import os
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

API = "https://leekwars.com/api/"
CACHE_DIR = Path(__file__).resolve().parent / ".cache"

# Types d'effet du moteur (constantes officielles EFFECT_*).
E_DAMAGE, E_HEAL, E_BUFF_STRENGTH, E_BUFF_AGILITY, E_RELATIVE_SHIELD, E_ABSOLUTE_SHIELD = 1, 2, 3, 4, 5, 6
E_BUFF_MP, E_BUFF_TP, E_POISON = 7, 8, 13
E_RAW_BUFF_MP, E_RAW_BUFF_TP, E_RAW_BUFF_STRENGTH, E_RAW_BUFF_AGILITY = 31, 32, 38, 41

TARGET_ENEMIES, TARGET_CASTER = 1, 4
MODIFIER_ON_CASTER = 4


@dataclass(frozen=True)
class Effect:
    type: int
    value1: float
    value2: float
    turns: int
    targets: int
    modifiers: int

    @property
    def average(self) -> float:
        return self.value1 + self.value2 / 2

    @property
    def on_caster(self) -> bool:
        return bool(self.targets & TARGET_CASTER) or bool(self.modifiers & MODIFIER_ON_CASTER)

    @property
    def on_enemy(self) -> bool:
        return bool(self.targets & TARGET_ENEMIES) and not self.modifiers & MODIFIER_ON_CASTER


@dataclass(frozen=True)
class Item:
    name: str
    kind: str  # "weapon" | "chip"
    level: int
    cost: int
    min_range: int
    max_range: int
    cooldown: int  # puce : tours avant de relancer (0 = aucun, -1 = une fois par combat) ; arme : 0
    max_uses: int  # -1 = pas de plafond par tour
    effects: tuple[Effect, ...]
    forgotten: bool = False
    game_id: int = 0
    launch_type: int = 7  # 7 = toutes cases ; 1 = ligne, 2 = diagonale, 4 = étoile…

    @property
    def event_item(self) -> bool:
        """Puces à numéro ≥ 400 : objets d'événement, ni achetables ni équipables en combat ordinaire."""
        return self.kind == "chip" and self.game_id >= 400

    @property
    def stateful(self) -> bool:
        """Une puce dont le cooldown dépasse 1 tour : son état est suivi d'un tour à l'autre."""
        return self.kind == "chip" and (self.cooldown >= 2 or self.cooldown < 0)

    def uses_per_turn(self, tp: int) -> int:
        cap = tp // self.cost if self.cost > 0 else tp
        if self.kind == "chip" and self.cooldown == 1:
            limit = 1
        elif self.stateful:
            limit = 1
        else:
            limit = self.max_uses if self.max_uses > 0 else cap
        return min(limit, cap)


def _effects(raw: Iterable[dict]) -> tuple[Effect, ...]:
    return tuple(
        Effect(e["id"], e["value1"], e["value2"], e["turns"], e.get("targets", 0), e.get("modifiers", 0)) for e in raw
    )


def _get_json(path: str, refresh: bool, token: str | None = None) -> dict:
    CACHE_DIR.mkdir(exist_ok=True)
    cache = CACHE_DIR / (path.replace("/", "_") + ".json")
    if token is None and cache.exists() and not refresh:
        return json.loads(cache.read_text(encoding="utf-8"))
    request = urllib.request.Request(API + path, headers={"User-Agent": "leekwars-loadout-tool"})
    if token:
        request.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.loads(response.read().decode("utf-8"))
    if token is None:
        cache.write_text(json.dumps(data), encoding="utf-8")
    return data


def parse_weapons(data: dict) -> dict[str, Item]:
    items = {}
    for raw in data["weapons"].values():
        items[raw["name"]] = Item(
            raw["name"], "weapon", raw["level"], raw["cost"], raw["min_range"], raw["max_range"], 0,
            raw.get("max_uses", -1), _effects(raw["effects"]), bool(raw.get("forgotten", False)), raw["id"], raw.get("launch_type", 7),
        )
    return items


def parse_chips(data: dict) -> dict[str, Item]:
    items = {}
    for raw in data["chips"].values():
        items[raw["name"]] = Item(
            raw["name"], "chip", raw["level"], raw["cost"], raw["min_range"], raw["max_range"],
            raw.get("cooldown", 0), raw.get("max_uses", -1), _effects(raw["effects"]), False, raw["id"], raw.get("launch_type", 7),
        )
    return items


@dataclass(frozen=True)
class Leek:
    name: str
    level: int
    life: int
    strength: int
    agility: int
    wisdom: int
    resistance: int
    science: int
    magic: int
    tp: int
    mp: int
    max_weapons: int
    max_chips: int
    equipped_weapons: tuple[str, ...]
    equipped_chips: tuple[str, ...]


def parse_leek(data: dict, weapons: dict[str, Item], chips: dict[str, Item]) -> Leek:
    # `template` d'une arme équipée = champ `item` du catalogue ; celui d'une puce = son `id`.
    return Leek(
        data["name"], data["level"], data["total_life"], data["total_strength"], data["total_agility"],
        data["total_wisdom"], data["total_resistance"], data["total_science"], data["total_magic"],
        data["total_tp"], data["total_mp"], data["max_weapons"], data["max_chips"], (), (),
    )


def load_catalog(refresh: bool = False) -> tuple[dict[str, Item], dict[str, Item], dict[int, str], dict[int, str]]:
    """(armes, puces, nom d'arme par `item`, nom de puce par `id`) : les deux index servent à lire un poireau."""
    raw_w, raw_c = _get_json("weapon/get-all", refresh), _get_json("chip/get-all", refresh)
    weapon_names = {raw["item"]: raw["name"] for raw in raw_w["weapons"].values()}
    chip_names = {raw["id"]: raw["name"] for raw in raw_c["chips"].values()}
    return parse_weapons(raw_w), parse_chips(raw_c), weapon_names, chip_names


def load_leek(leek_id: int, refresh: bool = False) -> Leek:
    weapons, chips, weapon_names, chip_names = load_catalog(refresh)
    data = _get_json(f"leek/get/{leek_id}", refresh=True)
    leek = parse_leek(data, weapons, chips)
    equipped_w = tuple(weapon_names[w["template"]] for w in data.get("weapons", []) if w["template"] in weapon_names)
    equipped_c = tuple(chip_names[c["template"]] for c in data.get("chips", []) if c["template"] in chip_names)
    return Leek(**{**leek.__dict__, "equipped_weapons": equipped_w, "equipped_chips": equipped_c})


def owned_from_account(login: str, password: str, leek_id: int) -> tuple[list[str], list[str]]:
    """Inventaire du compte (connexion par jeton, non conservé)."""
    weapons, chips, weapon_names, chip_names = load_catalog()
    body = json.dumps({"login": login, "password": password}).encode()
    request = urllib.request.Request(
        API + "farmer/login-token", data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        token = json.loads(response.read().decode())["token"]
    farmer = _get_json("farmer/get-from-token", refresh=True, token=token)["farmer"]
    owned_w = sorted({weapon_names[w["template"]] for w in farmer.get("weapons", {}).values() if w["template"] in weapon_names})
    owned_c = sorted({chip_names[c["template"]] for c in farmer.get("chips", {}).values() if c["template"] in chip_names})
    return owned_w, owned_c


def pool_items(
    mode: str, leek: Leek, weapons: dict[str, Item], chips: dict[str, Item],
    owned: tuple[list[str], list[str]] | None = None, exclude: Iterable[str] = (),
) -> tuple[list[Item], list[Item]]:
    """(armes, puces) candidates, triées par nom pour un résultat reproductible."""
    banned = set(exclude)

    def keep(item: Item, names: list[str] | None) -> bool:
        if item.name in banned or item.forgotten or (mode != "all" and item.event_item):
            return False
        if mode == "owned":
            return names is not None and item.name in names
        if mode == "level":
            return item.level <= leek.level or item.name in leek.equipped_weapons + leek.equipped_chips
        return True

    if mode == "owned" and owned is None:
        raise ValueError("--pool owned demande --owned-file ou LW_LOGIN / LW_PASSWORD")
    ws = sorted((i for i in weapons.values() if keep(i, owned[0] if owned else None)), key=lambda i: i.name)
    cs = sorted((i for i in chips.values() if keep(i, owned[1] if owned else None)), key=lambda i: i.name)
    return ws, cs
