"""Generate the app icons in icons/. Run from the repo root: `uv run --no-project --with pillow tools/make-icons.py`.

The design is full-bleed, with the glyph inside the central 60%, so the same drawing works as a maskable icon.
"""
from pathlib import Path

from PIL import Image, ImageDraw

BG = (42, 120, 214)  # --series-1 light
FG = (255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "icons"


def icon(size: int, maskable: bool) -> Image.Image:
    scale = 4  # draw large, downsample for smooth edges
    s = size * scale
    img = Image.new("RGB", (s, s), BG)
    d = ImageDraw.Draw(img)
    inset = 0.24 if maskable else 0.18
    lo, hi = s * inset, s * (1 - inset)
    w = max(2, round(s * 0.035))
    # axes
    d.line([(lo, lo), (lo, hi), (hi, hi)], fill=FG, width=w, joint="curve")
    # a falling-then-rising line with markers
    xs = [lo + (hi - lo) * f for f in (0.15, 0.4, 0.65, 0.9)]
    ys = [lo + (hi - lo) * f for f in (0.30, 0.55, 0.45, 0.15)]
    pts = list(zip(xs, ys))
    d.line(pts, fill=FG, width=w, joint="curve")
    r = s * 0.035
    for x, y in pts:
        d.ellipse([x - r, y - r, x + r, y + r], fill=FG)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    icon(192, False).save(OUT / "icon-192.png")
    icon(512, False).save(OUT / "icon-512.png")
    icon(512, True).save(OUT / "icon-maskable-512.png")
    print("wrote", *sorted(p.name for p in OUT.glob("*.png")))
