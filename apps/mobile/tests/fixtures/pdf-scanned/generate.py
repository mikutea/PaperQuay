"""Regenerate original CC0 scan fixtures with Python 3 + Pillow (JPEG2000 enabled).

SPDX-License-Identifier: CC0-1.0
The geometric artwork, PDF assembly, and generated fixture files are dedicated
to the public domain. No downloaded document or third-party artwork is included.
Run this file from any directory; normal regression tests use the checked-in PDFs.
"""
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import struct

from PIL import Image, ImageDraw, features, __version__ as pillow_version


DESTINATION = Path(__file__).parent
SIZE = 96


def artwork(color, alternate):
    image = Image.new("RGB" if color else "1", (SIZE, SIZE), "white")
    draw = ImageDraw.Draw(image)
    colors = [(224, 32, 32), (24, 160, 48), (24, 64, 224), (240, 192, 16)] if color else [0] * 4
    for rectangle, fill in zip([(8, 8, 39, 39), (56, 8, 87, 39), (8, 56, 39, 87), (56, 56, 87, 87)], colors):
        draw.rectangle(rectangle, fill=fill)
    draw.rectangle((20, 20, 27, 27), fill="white")
    draw.rectangle((64, 64, 79, 71), fill="white")
    draw.rectangle((44, 12, 47, 83), fill=colors[0])
    return image.transpose(Image.Transpose.ROTATE_90) if alternate else image


def group4(image):
    encoded = BytesIO()
    # The extracted stream has no TIFF photometric tag. Invert Pillow's BlackIsZero
    # input to obtain the white-zero MMR convention used by the embedded PDF stream.
    image.point(lambda value: 255 - value).save(encoded, format="TIFF", compression="group4")
    data = encoded.getvalue()
    with Image.open(BytesIO(data)) as saved:
        offsets, counts = saved.tag_v2[273], saved.tag_v2[279]
        assert len(offsets) == len(counts) == 1
        return data[offsets[0]:offsets[0] + counts[0]]


def jbig2(image):
    def segment(number, kind, data):
        # Embedded sequential segments: no references, one-byte page association.
        return struct.pack(">IBBBI", number, kind, 0, 1, len(data)) + data
    page = struct.pack(">IIIIBH", SIZE, SIZE, 0, 0, 0, 0)
    # Immediate generic region with MMR coding and OR combination.
    region = struct.pack(">IIIIBB", SIZE, SIZE, 0, 0, 0, 1) + group4(image)
    return segment(1, 48, page) + segment(2, 38, region) + segment(3, 49, b"")


def pdf(images, codec):
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>"]
    for index, image in enumerate(images):
        page_id = 3 + index * 3
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {SIZE} {SIZE}] /Resources << /XObject << /Scan {page_id + 2} 0 R >> >> /Contents {page_id + 1} 0 R >>".encode())
        content = f"q {SIZE} 0 0 {SIZE} 0 0 cm /Scan Do Q".encode()
        objects.append(f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream")
        if codec == "jpx":
            encoded = BytesIO()
            image.save(encoded, format="JPEG2000", irreversible=False, mct=0)
            data, filter_name, color_space, bits, extra = encoded.getvalue(), "JPXDecode", "DeviceRGB", 8, ""
        elif codec == "jbig2":
            data, filter_name, color_space, bits, extra = jbig2(image), "JBIG2Decode", "DeviceGray", 1, ""
        else:
            data, filter_name, color_space, bits = group4(image), "CCITTFaxDecode", "DeviceGray", 1
            extra = f" /DecodeParms << /K -1 /Columns {SIZE} /Rows {SIZE} /BlackIs1 false >>"
        header = f"<< /Type /XObject /Subtype /Image /Width {SIZE} /Height {SIZE} /ColorSpace /{color_space} /BitsPerComponent {bits} /Interpolate false /Filter /{filter_name}{extra} /Length {len(data)} >>\nstream\n"
        objects.append(header.encode() + data + b"\nendstream")
    data = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n% Original CC0 geometric scan fixture\n")
    offsets = [0]
    for number, obj in enumerate(objects, start=1):
        offsets.append(len(data))
        data.extend(f"{number} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(data)
    data.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        data.extend(f"{offset:010d} 00000 n \n".encode())
    data.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(data)


manifest = {"license": "CC0-1.0", "generator": {"pillow": pillow_version, "openjpeg": features.version_codec("jpg_2000")}, "width": SIZE, "height": SIZE, "fixtures": []}
for codec in ["jpx", "jbig2", "ccitt"]:
    images = [artwork(codec == "jpx", alternate) for alternate in [False, True]]
    data = pdf(images, codec)
    (DESTINATION / f"{codec}.pdf").write_bytes(data)
    pages = []
    for image in images:
        rgba = image.convert("RGBA")
        pixels = rgba.tobytes()
        pages.append({
            "rgbaSha256": sha256(pixels).hexdigest(),
            "nonwhitePixels": sum(pixels[offset:offset + 3] != b"\xff\xff\xff" for offset in range(0, len(pixels), 4)),
            "samples": [[x, y, *rgba.getpixel((x, y))] for x, y in [
                (0, 0), (10, 10), (24, 24), (60, 10), (10, 60), (60, 60), (70, 68), (45, 50), (50, 45), (90, 90)
            ]],
        })
    manifest["fixtures"].append({"name": codec, "bytes": len(data), "sha256": sha256(data).hexdigest(), "pages": pages})
(DESTINATION / "expected.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(json.dumps({entry["name"]: entry["bytes"] for entry in manifest["fixtures"]}))
