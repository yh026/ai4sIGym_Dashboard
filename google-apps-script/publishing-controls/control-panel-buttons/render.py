"""Regenerate the three embedded worksheet button images (Pillow required)."""
import argparse
import base64
import io
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", default="/System/Library/Fonts/STHeiti Medium.ttc")
    parser.add_argument("--preview-dir", type=Path)
    args = parser.parse_args()
    scale = 3
    font = ImageFont.truetype(args.font, 15 * scale)
    artwork = {}
    for key, label, fill, text in [
        ("preview", "更新预览", "#345968", "#ffffff"),
        ("production", "发布正式版", "#fffefa", "#203341"),
        ("refresh", "刷新状态", "#fffefa", "#203341"),
    ]:
        image = Image.new("RGBA", (220 * scale, 36 * scale))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((1, 1, image.width - 2, image.height - 2), radius=7 * scale,
                               fill=fill, outline="#b7c3c9", width=scale)
        box = draw.textbbox((0, 0), label, font=font)
        draw.text(((image.width - box[2] - box[0]) / 2, (image.height - box[3] - box[1]) / 2),
                  label, font=font, fill=text)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=True)
        artwork[key] = base64.b64encode(buffer.getvalue()).decode("ascii")
        if args.preview_dir:
            args.preview_dir.mkdir(parents=True, exist_ok=True)
            image.save(args.preview_dir / (key + ".png"))
    Path(__file__).with_name("artwork.json").write_text(json.dumps(artwork, indent=2) + "\n")


if __name__ == "__main__":
    main()
