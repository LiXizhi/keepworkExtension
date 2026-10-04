"""Validate isolated feedback pixels, margins and repeated fixed poses."""
import hashlib
import json
import sys
from pathlib import Path
from PIL import Image, ImageChops

report_path = Path(sys.argv[1])
report = json.loads(report_path.read_text(encoding="utf-8-sig"))
frames, repeats = [], {}
for entry in report["images"]:
    metadata = entry["metadata"]
    assert metadata["isolated"] and metadata["mimeType"] == "image/png"
    image = Image.open(entry["file"]).convert("RGBA")
    assert image.size == (metadata["width"], metadata["height"])
    rgb = image.convert("RGB")
    background = Image.new("RGB", image.size, (245, 247, 250))
    difference = ImageChops.difference(rgb, background)
    mask = ImageChops.lighter(ImageChops.lighter(*difference.split()[:2]), difference.split()[2])
    bbox = mask.point(lambda value: 255 if value > 6 else 0).getbbox()
    assert bbox, "Empty isolated render"
    margins = (bbox[0], bbox[1], image.width - bbox[2], image.height - bbox[3])
    assert min(margins) >= 8, f"Clipped model: {entry['file']}, {bbox}"
    assert image.getchannel("A").getextrema() == (255, 255), "Neutral feedback image should be opaque"
    digest = hashlib.sha256(image.tobytes()).hexdigest()
    subject = metadata.get("asset") or metadata["assembly"]
    key = json.dumps({"subject": subject, "camera": metadata["cameraPos"]}, sort_keys=True)
    repeats.setdefault(key, []).append(digest)
    frames.append({"file": entry["file"], "bounds": bbox, "margins": margins, "rgbaSha256": digest})
stable_groups = [values for values in repeats.values() if len(values) >= 3]
assert stable_groups and all(len(set(values)) == 1 for values in stable_groups), "Repeated fixed-pose pixels differ"
output = report_path.with_name("image-check.json")
output.write_text(json.dumps({"frames": frames, "stableRepeatedPoses": len(stable_groups)}, indent=2), encoding="utf-8")
print(f"PASS {len(frames)} decoded PNGs: nonempty, unclipped, opaque neutral background and stable repeated pose")
