#!/usr/bin/env python3
"""Render the iOS app icon from build/icon.svg geometry.

The repo ships an SVG icon; Xcode needs a 1024x1024 opaque PNG in an asset
catalog.  This script re-draws the same shapes (same colours, same geometry)
with Pillow, so  ios/WorldVinyl/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png
can be regenerated instead of being an unreviewable binary blob.

Usage:  python ios/tools/make-icon.py
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

SIZE = 1024
SUPERSAMPLE = 4
BIG = SIZE * SUPERSAMPLE

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "ios" / "WorldVinyl" / "Assets.xcassets" / "AppIcon.appiconset" / "AppIcon-1024.png"


def hex_rgb(value: str) -> np.ndarray:
    value = value.lstrip("#")
    return np.array([int(value[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float64)


def linear_gradient(size: int, start: str, end: str) -> Image.Image:
    """Diagonal (top-left -> bottom-right) two-stop gradient."""
    xs, ys = np.meshgrid(np.arange(size), np.arange(size))
    t = ((xs + ys) / (2.0 * (size - 1)))[..., None]
    a, b = hex_rgb(start), hex_rgb(end)
    rgb = a + (b - a) * t
    return Image.fromarray(rgb.round().astype(np.uint8), mode="RGB")


def radial_gradient(size: int, center: tuple[float, float], radius: float,
                    stops: list[tuple[float, str]]) -> Image.Image:
    """Offset radial gradient, stops given as (fraction, hex colour)."""
    cx, cy = center[0] * size, center[1] * size
    ys, xs = np.mgrid[0:size, 0:size]
    dist = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2) / radius
    t = np.clip(dist, 0.0, 1.0)

    positions = [p for p, _ in stops]
    channels = [hex_rgb(c) for _, c in stops]
    out = np.empty((size, size, 3), dtype=np.float64)
    for ch in range(3):
        out[..., ch] = np.interp(t, positions, [c[ch] for c in channels])
    return Image.fromarray(out.round().astype(np.uint8), mode="RGB")


def sample_path(d: str, steps: int = 24) -> list[tuple[float, float]]:
    """Flatten the SVG path in build/icon.svg (absolute M + relative c's + Z)."""
    tokens = re.findall(r"[MczZ]|-?\d+(?:\.\d+)?", d)
    points: list[tuple[float, float]] = []
    cursor = (0.0, 0.0)
    start = (0.0, 0.0)
    index = 0
    command = None

    while index < len(tokens):
        token = tokens[index]
        if token in ("M", "c", "z", "Z"):
            command = token
            index += 1
            if command in ("z", "Z"):
                points.append(start)
            continue

        if command == "M":
            cursor = (float(tokens[index]), float(tokens[index + 1]))
            start = cursor
            points.append(cursor)
            index += 2
            command = "c"  # subsequent coordinate pairs are relative cubics
            continue

        if command == "c":
            x0, y0 = cursor
            x1, y1 = float(tokens[index]), float(tokens[index + 1])
            x2, y2 = float(tokens[index + 2]), float(tokens[index + 3])
            x3, y3 = float(tokens[index + 4]), float(tokens[index + 5])
            index += 6
            for step in range(1, steps + 1):
                u = step / steps
                v = 1 - u
                points.append((
                    v ** 3 * x0 + 3 * v * v * u * (x0 + x1) + 3 * v * u * u * (x0 + x2) + u ** 3 * (x0 + x3),
                    v ** 3 * y0 + 3 * v * v * u * (y0 + y1) + 3 * v * u * u * (y0 + y2) + u ** 3 * (y0 + y3),
                ))
            cursor = (x0 + x3, y0 + y3)
            continue

        index += 1

    return points


def scaled(points: list[tuple[float, float]], scale: float) -> list[tuple[float, float]]:
    return [(x * scale, y * scale) for x, y in points]


def ring(draw: ImageDraw.ImageDraw, radius: float, colour, width: float) -> None:
    draw.ellipse(
        [BIG / 2 - radius, BIG / 2 - radius, BIG / 2 + radius, BIG / 2 + radius],
        outline=colour,
        width=int(width),
    )


def build_icon() -> Image.Image:
    scale = SUPERSAMPLE

    # Background: diagonal gradient, same stops as the SVG.
    canvas = linear_gradient(SIZE, "#1a2f3d", "#071018").resize((BIG, BIG), Image.LANCZOS)

    # Outer dark disc, then the gold rim on top of it (fill must not cover the rim).
    solid = Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))
    ImageDraw.Draw(solid).ellipse(
        [BIG / 2 - 368 * scale, BIG / 2 - 368 * scale, BIG / 2 + 368 * scale, BIG / 2 + 368 * scale],
        fill="#080b13ff",
    )
    canvas = Image.alpha_composite(canvas.convert("RGBA"), solid)
    ring(ImageDraw.Draw(canvas), 368 * scale, "#d9a441", 12 * scale)

    # Vinyl surface: offset radial gradient.
    disc = radial_gradient(
        SIZE,
        center=(0.34, 0.28),
        radius=0.78 * SIZE,
        stops=[(0.0, "#5c6b9a"), (0.55, "#292c55"), (1.0, "#0e111d")],
    ).resize((BIG, BIG), Image.LANCZOS)
    mask = Image.new("L", (BIG, BIG), 0)
    ImageDraw.Draw(mask).ellipse(
        [BIG / 2 - 334 * scale, BIG / 2 - 334 * scale, BIG / 2 + 334 * scale, BIG / 2 + 334 * scale],
        fill=255,
    )
    canvas = Image.composite(disc.convert("RGBA"), canvas, mask)
    ring(ImageDraw.Draw(canvas), 334 * scale, "#303449", 8 * scale)

    # Grooves.
    overlay = Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for radius in range(70, 309, 34):
        ring(draw, radius * scale, "#9ca4d63d", 7 * scale)
    canvas = Image.alpha_composite(canvas, overlay)

    # Graticule, clipped to the globe circle.
    globe = Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(globe)
    cx = cy = BIG / 2
    gdraw.ellipse([cx - 300 * scale, cy - 105 * scale, cx + 300 * scale, cy + 105 * scale],
                  outline="#76d7c2d1", width=int(12 * scale))
    gdraw.ellipse([cx - 155 * scale, cy - 300 * scale, cx + 155 * scale, cy + 300 * scale],
                  outline="#76d7c2d1", width=int(12 * scale))
    for y in (360, 512, 664):
        gdraw.line([(212 * scale, y * scale), (812 * scale, y * scale)],
                   fill="#76d7c2d1", width=int(12 * scale))

    path = sample_path(
        "M392 453c55-40 104-18 131-53 29-37 56-25 84 3 22 22 58 17 76 56 "
        "14 31-23 50-33 79-12 32-3 72-39 78-43 7-71-28-110-19-37 8-49 48-84 37 "
        "-36-12-35-59-57-83-21-23-55-38-47-70 6-22 46-18 79-28Z"
    )
    gdraw.polygon(scaled(path, scale), fill="#79c98fe0", outline="#b6e2aaff", width=int(7 * scale))

    globe_mask = Image.new("L", (BIG, BIG), 0)
    ImageDraw.Draw(globe_mask).ellipse(
        [cx - 300 * scale, cy - 300 * scale, cx + 300 * scale, cy + 300 * scale], fill=255
    )
    canvas = Image.alpha_composite(canvas, Image.composite(globe, Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0)), globe_mask))

    # Centre label + spindle hole.
    labels = Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))
    ldraw = ImageDraw.Draw(labels)
    ldraw.ellipse([cx - 54 * scale, cy - 54 * scale, cx + 54 * scale, cy + 54 * scale],
                  fill="#f6c76cff", outline="#fff0aeff", width=int(8 * scale))
    ldraw.ellipse([cx - 16 * scale, cy - 16 * scale, cx + 16 * scale, cy + 16 * scale], fill="#202233ff")
    ring(ldraw, 392 * scale, "#76d7c240", 8 * scale)
    canvas = Image.alpha_composite(canvas, labels)

    return canvas.convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    icon = build_icon()
    icon.save(OUT, format="PNG", optimize=True)
    print(f"wrote {OUT.relative_to(ROOT)} ({icon.size[0]}x{icon.size[1]})")


if __name__ == "__main__":
    main()
