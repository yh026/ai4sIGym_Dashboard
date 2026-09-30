#!/usr/bin/env python3
"""Create the home map's lossless WebP and verify decoded pixel identity.

Run with Python 3 and Pillow built with WebP support. The source PNG is kept
unchanged. No resizing, quantization, or lossy image encoding is performed.
"""

import hashlib
import json
from pathlib import Path
import tempfile

from PIL import Image, __version__ as pillow_version, features


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "site/assets/ais-science-map-v2-lines.png"
OUTPUT = ROOT / "site/assets/ais-science-map-v2-lines.lossless.webp"
EVIDENCE = ROOT / "docs/evidence/home-map-lossless.json"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def main():
    if not features.check("webp"):
        raise RuntimeError("Pillow must include WebP support.")

    source_bytes = SOURCE.read_bytes()
    with Image.open(SOURCE) as original:
        original.load()
        if original.mode not in ("RGB", "RGBA") or original.is_animated:
            raise ValueError("Expected one RGB or RGBA image; review other formats first.")
        # PNG-specific color interpretation cannot simply be discarded. The
        # current asset has none of these fields; stop if that changes later.
        unsupported_color_metadata = {"gamma", "chromaticity"} & original.info.keys()
        if unsupported_color_metadata:
            raise ValueError("Review PNG color metadata before converting: "
                             + ", ".join(sorted(unsupported_color_metadata)))

        original_pixels = original.convert("RGBA").tobytes()
        metadata = {key: original.info[key] for key in ("icc_profile", "exif")
                    if key in original.info}
        with tempfile.TemporaryDirectory(prefix="ais-home-map-") as temp:
            candidate = Path(temp) / "map.webp"
            original.save(candidate, format="WEBP", lossless=True,
                          quality=100, method=6, exact=True, **metadata)
            with Image.open(candidate) as decoded:
                decoded.load()
                decoded_pixels = decoded.convert("RGBA").tobytes()
                if decoded.size != original.size or decoded_pixels != original_pixels:
                    raise RuntimeError("Lossless verification failed; output was not saved.")
                for key, value in metadata.items():
                    if decoded.info.get(key) != value:
                        raise RuntimeError(f"Metadata preservation failed: {key}")

            output_bytes = candidate.read_bytes()
            if len(output_bytes) >= len(source_bytes):
                raise RuntimeError("WebP did not reduce file size; output was not saved.")
            if SOURCE.read_bytes() != source_bytes:
                raise RuntimeError("Source changed during conversion; rerun before saving.")
            OUTPUT.write_bytes(output_bytes)

        evidence = {
            "purpose": "Smaller home-page background with identical decoded RGBA pixels.",
            "source": {
                "path": SOURCE.relative_to(ROOT).as_posix(),
                "bytes": len(source_bytes),
                "sha256": sha256(source_bytes),
                "mode": original.mode,
                "metadata_keys": sorted(original.info.keys()),
            },
            "output": {
                "path": OUTPUT.relative_to(ROOT).as_posix(),
                "bytes": len(output_bytes),
                "sha256": sha256(output_bytes),
                "format": "WebP lossless",
            },
            "verification": {
                "width": original.width,
                "height": original.height,
                "decoded_format": "RGBA, 8 bits per channel, row-major order",
                "source_rgba_sha256": sha256(original_pixels),
                "output_rgba_sha256": sha256(decoded_pixels),
                "dimensions_identical": True,
                "pixels_identical": True,
                "source_preserved": True,
                "preserved_metadata_keys": sorted(metadata),
            },
            "bytes_saved": len(source_bytes) - len(output_bytes),
            "percent_smaller": round((1 - len(output_bytes) / len(source_bytes)) * 100, 2),
            "encoder": {
                "pillow": pillow_version,
                "libwebp": features.version("webp"),
                "settings": {"lossless": True, "quality": 100, "method": 6, "exact": True},
            },
            "reproduce": "python3 scripts/optimize-home-map.py (requires Pillow with WebP support)",
        }
        EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
        EVIDENCE.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
        print(f"Verified identical {original.width} x {original.height} RGBA pixels; "
              f"saved {evidence['bytes_saved']:,} bytes ({evidence['percent_smaller']}%).")


if __name__ == "__main__":
    main()
