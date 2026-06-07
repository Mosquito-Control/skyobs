"""Merge Roboflow datasets into a single combined dataset for yolo train.

Usage:
    python tools/merge_datasets.py

Reads:
    datasets/zhejiang/   (Zhejiang University drone dataset)
    datasets/detfly/     (DetFly drone dataset)

Writes:
    datasets/combined/train/images/
    datasets/combined/train/labels/
    datasets/combined/valid/images/
    datasets/combined/valid/labels/
    datasets/combined/data.yaml

Class remapping
---------------
Zhejiang exports with nc=2, names=['0','drone']: class 0 is an unlabelled
object class (treated as drone) and class 1 is 'drone'. Both are remapped to
combined class 0 = 'drone'.
DetFly exports with nc=1, names=['UAV']: class 0 is 'UAV' (drone), remapped
to combined class 0 = 'drone'.
"""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).parent.parent
DATASETS = ROOT / "datasets"
OUT = DATASETS / "combined"
SPLITS = ["train", "valid"]

COMBINED_NAMES = ["drone"]

# Per-source mapping: old class index → new class index
CLASS_MAPS: dict[str, dict[int, int]] = {
    "zhejiang": {0: 0, 1: 0},  # both classes → drone
    "detfly": {0: 0},           # UAV → drone
}


def _remap_label(src: Path, dst: Path, class_map: dict[int, int]) -> None:
    lines = src.read_text().splitlines()
    out_lines = []
    for line in lines:
        if not line.strip():
            continue
        parts = line.split()
        new_cls = class_map.get(int(parts[0]), int(parts[0]))
        out_lines.append(f"{new_cls} {' '.join(parts[1:])}")
    dst.write_text("\n".join(out_lines) + ("\n" if out_lines else ""))


def _copy_split(
    src_root: Path,
    split: str,
    dst_root: Path,
    prefix: str,
    class_map: dict[int, int],
) -> tuple[int, int]:
    imgs_copied = labels_copied = 0
    for kind in ("images", "labels"):
        src = src_root / split / kind
        dst = dst_root / split / kind
        dst.mkdir(parents=True, exist_ok=True)
        if not src.exists():
            print(f"  WARNING: {src} not found, skipping")
            continue
        for f in src.iterdir():
            dest = dst / f"{prefix}_{f.name}"
            if kind == "labels":
                _remap_label(f, dest, class_map)
            else:
                shutil.copy2(f, dest)
            if kind == "images":
                imgs_copied += 1
            else:
                labels_copied += 1
    return imgs_copied, labels_copied


def main() -> None:
    sources = list(CLASS_MAPS.keys())
    missing = [s for s in sources if not (DATASETS / s).exists()]
    if missing:
        raise SystemExit(
            f"Missing dataset directories: {missing}\n"
            "Download and extract them first — see FINETUNING.md Step 1."
        )

    if OUT.exists():
        shutil.rmtree(OUT)

    total_imgs = total_labels = 0
    for split in SPLITS:
        for src_name, class_map in CLASS_MAPS.items():
            src_root = DATASETS / src_name
            imgs, labels = _copy_split(src_root, split, OUT, prefix=src_name, class_map=class_map)
            print(f"  {src_name}/{split}: {imgs} images, {labels} labels")
            total_imgs += imgs
            total_labels += labels

    yaml_lines = [
        f"path: {OUT.resolve()}",
        "train: train/images",
        "val: valid/images",
        "",
        f"nc: {len(COMBINED_NAMES)}",
        f"names: {COMBINED_NAMES}",
        "",
    ]
    (OUT / "data.yaml").write_text("\n".join(yaml_lines))

    print(f"\nDone. Combined dataset at: {OUT}")
    print(f"Total: {total_imgs} images, {total_labels} labels")
    print(f"Classes ({len(COMBINED_NAMES)}): {COMBINED_NAMES}")
    print("\nNext step:")
    print(
        "  yolo train model=models/yolov11x-drone.pt"
        " data=datasets/combined/data.yaml epochs=50 imgsz=640 batch=16"
    )


if __name__ == "__main__":
    main()
