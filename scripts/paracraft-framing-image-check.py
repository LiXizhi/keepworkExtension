"""Compare measured foreground framing against the preceding car capture round."""
import json
import sys
from pathlib import Path

current = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
previous = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8-sig"))

def deviation(frame):
    _, top, _, bottom = frame["bounds"]
    return abs((top + bottom) / 2 - 256) / 512

new_error = max(map(deviation, current["frames"]))
old_error = max(map(deviation, previous["frames"]))
assert new_error < 0.10 and new_error < old_error / 2, "Automatic fit did not improve vertical centering"
for frame in current["frames"]:
    left, _, right, _ = frame["bounds"]
    assert 0.55 <= (right - left) / 512 <= 0.9, "Car too small or excessively zoomed"
    assert min(frame["margins"]) >= 32, "Automatic fit left insufficient breathing room"
result = {"maximumVerticalCenterError": new_error, "previousMaximumError": old_error,
          "frames": len(current["frames"]), "minimumMarginPixels": min(min(f["margins"]) for f in current["frames"])}
Path(sys.argv[1]).with_name("framing-check.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
print("PASS automatic fit: better centering, useful car coverage and generous margins", result)
