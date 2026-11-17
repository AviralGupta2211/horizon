#!/usr/bin/env python3
"""
Real brain lens for Horizon, using Meta's TRIBE v2.

What it does
    For each thing on a Horizon map, TRIBE v2 predicts how an average brain would
    respond to hearing those words. This script averages that predicted response
    over six coarse cortical systems and writes a JSON file that Horizon can load
    (More > Brain lens > "Paste the script's output").

What it does not do
    It does not measure anyone's brain. TRIBE v2 takes a stimulus (here: your
    sentence, turned into speech) and predicts the fMRI response of an *average*
    subject. The numbers describe the words, not the speaker, and they say
    nothing about where a belief is stored or where it came from.

Licence
    TRIBE v2 is CC BY-NC 4.0: research and prototypes only, not a paid product.

Setup (a machine with a GPU, or Colab)
    git clone https://github.com/facebookresearch/tribev2 && cd tribev2
    pip install -e ".[plotting]"          # the plotting extra brings nilearn
    huggingface-cli login                 # the text encoder (LLaMA 3.2) is gated
    python tribe_lens.py horizon_lens_input.json --out horizon_lens.json

Input
    The JSON copied from Horizon (More > Brain lens > "Copy the input for the
    script"), or a full Horizon export. Either way: a list of {id, text}.

Status
    The aggregation below is tested (run: python tribe_lens.py --self-test).
    The calls into TRIBE v2 follow its repository as of 15 Nov 2026
    (TribeModel.from_pretrained / get_events_dataframe / predict) but were not
    executed where this was written: no GPU and no model weights there.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import tempfile
from pathlib import Path

import numpy as np

# Six coarse systems, as groups of regions from the Destrieux atlas (aparc.a2009s).
# This grouping was chosen for the prototype. It is a rough reading aid, not a
# validated parcellation: real functional networks do not follow these borders.
SYSTEMS = {
    "language": {  # perisylvian language regions, left hemisphere
        "hemi": "left",
        "labels": ["G_front_inf-Opercular", "G_front_inf-Triangul", "G_front_inf-Orbital",
                   "G_temp_sup-Lateral", "S_temporal_sup", "G_temporal_middle",
                   "G_pariet_inf-Supramar", "Pole_temporal"],
    },
    "minds": {  # regions most associated with thinking about other people and oneself
        "hemi": "both",
        "labels": ["G_pariet_inf-Angular", "G_precuneus", "G_cingul-Post-dorsal",
                   "G_and_S_cingul-Ant", "G_front_sup", "S_subparietal"],
    },
    "places": {  # scene and navigation regions
        "hemi": "both",
        "labels": ["G_oc-temp_med-Parahip", "S_collat_transv_ant", "S_collat_transv_post",
                   "S_oc-temp_med_and_Lingual", "G_cingul-Post-ventral", "S_parieto_occipital",
                   "S_oc_sup_and_transversal"],
    },
    "body": {  # sensorimotor strip
        "hemi": "both",
        "labels": ["G_precentral", "G_postcentral", "S_central", "G_and_S_paracentral",
                   "S_precentral-inf-part", "S_precentral-sup-part", "S_postcentral",
                   "G_and_S_subcentral"],
    },
    "sound": {  # auditory cortex
        "hemi": "both",
        "labels": ["G_temp_sup-G_T_transv", "S_temporal_transverse", "G_temp_sup-Plan_tempo",
                   "G_temp_sup-Plan_polar", "Lat_Fis-post"],
    },
    "vision": {  # occipital and ventral visual cortex
        "hemi": "both",
        "labels": ["Pole_occipital", "S_calcarine", "G_cuneus", "G_oc-temp_med-Lingual",
                   "G_occipital_middle", "G_occipital_sup", "G_and_S_occipital_inf",
                   "S_oc_middle_and_Lunatus", "G_oc-temp_lat-fusifor", "S_occipital_ant"],
    },
}

# Every item is heard as speech, so auditory cortex responds to all of them. To show
# what differs between items, each system is scored relative to a pool: the person's
# own items plus these plain reference sentences.
REFERENCE = [
    "The meeting has been moved to Thursday afternoon.",
    "There are twelve months in a year and seven days in a week.",
    "She walked down the hill, crossed the bridge and sat by the river.",
    "He picked up the heavy box with both hands and carried it upstairs.",
    "The band played quietly while the rain drummed on the roof.",
    "A bright red kite hung in the sky above the white houses.",
    "My brother thinks his friend is hiding what she really feels.",
    "If the premise is false, the argument does not follow.",
]


def load_atlas():
    """Destrieux surface atlas on fsaverage5: label names and one label index per vertex."""
    from nilearn import datasets

    atlas = datasets.fetch_atlas_surf_destrieux()
    labels = [l.decode() if isinstance(l, bytes) else str(l) for l in atlas["labels"]]
    return labels, np.asarray(atlas["map_left"]), np.asarray(atlas["map_right"])


def build_masks(labels, map_left, map_right):
    """One boolean mask per system over all vertices, left hemisphere first, then right."""
    masks = {}
    for name, spec in SYSTEMS.items():
        missing = [l for l in spec["labels"] if l not in labels]
        if missing:
            print(f"warning: {name}: atlas has no region named {missing}", file=sys.stderr)
        idx = [labels.index(l) for l in spec["labels"] if l in labels]
        if not idx:
            raise SystemExit(f"{name}: none of its regions exist in this atlas. Stopping.")
        left, right = np.isin(map_left, idx), np.isin(map_right, idx)
        if spec["hemi"] == "left":
            right = np.zeros_like(right)
        mask = np.concatenate([left, right])
        if not mask.any():
            raise SystemExit(f"{name}: the mask is empty. Stopping.")
        masks[name] = mask
    names = list(masks)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            both = int((masks[a] & masks[b]).sum())
            if both:
                raise SystemExit(f"{a} and {b} share {both} vertices. Each region may sit in one system only.")
    return masks


def system_means(preds, masks):
    """preds: (time, vertices). Average over time, then over each system's vertices."""
    if preds.ndim != 2:
        raise ValueError(f"expected (time, vertices), got {preds.shape}")
    n = next(iter(masks.values())).shape[0]
    if preds.shape[1] != n:
        raise ValueError(f"TRIBE returned {preds.shape[1]} vertices; the atlas has {n}. "
                         "This script assumes fsaverage5 with the left hemisphere first.")
    v = preds.mean(axis=0)
    return {name: float(v[mask].mean()) for name, mask in masks.items()}


def to_lens(raw):
    """raw: {key: {system: mean}}. Z-score each system across the pool, squash to 0..1."""
    keys = list(raw)
    out = {k: {} for k in keys}
    for name in SYSTEMS:
        vals = np.array([raw[k][name] for k in keys], dtype=float)
        sd = vals.std()
        z = (vals - vals.mean()) / sd if sd > 1e-12 else np.zeros_like(vals)
        for k, zi in zip(keys, z):
            out[k][name] = round(1.0 / (1.0 + math.exp(-float(zi))), 2)
    return out


def read_units(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    units = data.get("units")
    if units is None and isinstance(data.get("state"), dict):  # a full Horizon export
        units = [u for u in data["state"].get("units", []) if u.get("status") != "outline"]
    if not isinstance(units, list):
        raise SystemExit("Could not find a list of units in the input file.")
    clean = [{"id": str(u["id"]), "text": " ".join(str(u["text"]).split())}
             for u in units if isinstance(u, dict) and u.get("id") and str(u.get("text", "")).strip()]
    if not clean:
        raise SystemExit("The input has no units with text.")
    return clean


def text_key(text):
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def run(units, predict, masks, cache_path=None):
    """predict(text) -> array (time, vertices), or None when nothing could be predicted."""
    cache = {}
    if cache_path and Path(cache_path).exists():
        cache = json.loads(Path(cache_path).read_text())
    texts = {f"ref{i}": t for i, t in enumerate(REFERENCE)}
    texts.update({u["id"]: u["text"] for u in units})
    raw, skipped = {}, []
    for n, (key, text) in enumerate(texts.items(), 1):
        ck = text_key(text)
        if ck not in cache:
            preds = predict(text)
            if preds is None or len(preds) == 0:
                skipped.append(key)
                continue
            cache[ck] = system_means(np.asarray(preds), masks)
            if cache_path:
                Path(cache_path).write_text(json.dumps(cache))
        raw[key] = cache[ck]
        print(f"[{n}/{len(texts)}] {key}: {text[:60]}", file=sys.stderr)
    lens = to_lens(raw)
    return {
        "source": "tribe-v2",
        "note": "Predicted response of an average brain to hearing each item, by system, "
                "scored relative to the other items. Not a measurement of the speaker.",
        "units": {k: v for k, v in lens.items() if not k.startswith("ref")},
        "skipped": [k for k in skipped if not k.startswith("ref")],
    }


def tribe_predictor(cache_folder):
    from tribev2 import TribeModel  # noqa: imported here so --self-test needs no GPU stack

    model = TribeModel.from_pretrained("facebook/tribev2", cache_folder=cache_folder)
    workdir = Path(tempfile.mkdtemp(prefix="horizon_lens_"))

    def predict(text):
        path = workdir / f"{text_key(text)}.txt"
        path.write_text(text, encoding="utf-8")
        try:
            events = model.get_events_dataframe(text_path=str(path))  # text -> speech -> word timings
            preds, _segments = model.predict(events=events, verbose=False)
        except Exception as err:  # one bad item should not stop the run
            print(f"warning: could not predict for {text[:50]!r}: {err}", file=sys.stderr)
            return None
        return preds

    return predict


def self_test():
    """Checks the atlas grouping and the scoring with a made-up atlas and made-up predictions."""
    rng = np.random.default_rng(7)
    names = sorted({l for spec in SYSTEMS.values() for l in spec["labels"]})
    labels = ["Unknown", "Medial_wall"] + names + ["G_front_middle", "G_orbital"]
    n = 10242
    map_left, map_right = rng.integers(0, len(labels), n), rng.integers(0, len(labels), n)
    masks = build_masks(labels, map_left, map_right)
    assert set(masks) == set(SYSTEMS)
    assert not masks["language"][n:].any(), "language is left hemisphere only"
    assert all(m.shape == (2 * n,) for m in masks.values())

    def fake(text):  # every item drives 'sound'; some words drive one more system
        preds = rng.normal(0, 0.05, (6, 2 * n))
        preds[:, masks["sound"]] += 1.0
        for word, system in [("river", "places"), ("hill", "places"), ("friend", "minds"),
                             ("box", "body"), ("kite", "vision"), ("mountain", "places"), ("premise", "language")]:
            if word in text.lower():
                preds[:, masks[system]] += 0.8
        return preds

    units = [{"id": "u1", "text": "Mountains make my problems the right size."},
             {"id": "u2", "text": "My friend never says what she wants."},
             {"id": "u3", "text": "x"}]
    out = run(units, lambda t: None if t == "x" else fake(t), masks)
    assert out["source"] == "tribe-v2" and set(out["units"]) == {"u1", "u2"} and out["skipped"] == ["u3"]
    for lens in out["units"].values():
        assert set(lens) == set(SYSTEMS) and all(0.0 <= v <= 1.0 for v in lens.values())
    assert max(out["units"]["u1"], key=out["units"]["u1"].get) == "places", out["units"]["u1"]
    assert max(out["units"]["u2"], key=out["units"]["u2"].get) == "minds", out["units"]["u2"]
    assert 0.35 < out["units"]["u1"]["sound"] < 0.65, "speech itself is cancelled out by scoring against the pool"
    try:
        system_means(np.zeros((3, 100)), masks)
        raise AssertionError("a wrong vertex count must be refused")
    except ValueError:
        pass
    bad = dict(SYSTEMS)
    try:
        SYSTEMS["vision"]["labels"].append("G_precentral")
        build_masks(labels, map_left, map_right)
        raise AssertionError("overlapping systems must be refused")
    except SystemExit:
        pass
    finally:
        SYSTEMS["vision"]["labels"].remove("G_precentral")
        assert bad is not None
    print("self-test passed:", json.dumps(out["units"]))


def main():
    ap = argparse.ArgumentParser(description="Compute a TRIBE v2 brain lens for a Horizon map.")
    ap.add_argument("input", nargs="?", help="JSON copied from Horizon, or a Horizon export")
    ap.add_argument("--out", default="horizon_lens.json")
    ap.add_argument("--cache", default="./tribe_cache", help="folder for model weights and intermediate files")
    ap.add_argument("--self-test", action="store_true", help="check the aggregation without TRIBE or a GPU")
    args = ap.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.input:
        ap.error("give the input file, or use --self-test")
    units = read_units(args.input)
    masks = build_masks(*load_atlas())
    Path(args.cache).mkdir(parents=True, exist_ok=True)
    result = run(units, tribe_predictor(args.cache), masks, cache_path=str(Path(args.cache) / "horizon_system_means.json"))
    Path(args.out).write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(f"Wrote {args.out}: {len(result['units'])} items, {len(result['skipped'])} skipped. "
          "Paste its contents into Horizon under More > Brain lens.", file=sys.stderr)


if __name__ == "__main__":
    main()
