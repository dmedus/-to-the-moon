"""ANTERIOR: genera los íconos viejos (línea azul). El ícono actual (cohete de Boca) es public/icon.svg; no correr este script porque lo pisa."""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")
BLUE = (0x2A, 0x78, 0xD6)
WHITE = (255, 255, 255)
# Línea del logo en coordenadas de un lienzo de 32x32 (igual que icon.svg)
POINTS = [(7, 22), (13, 15), (18, 19), (25, 10)]


def dist_to_segment(px, py, a, b):
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def render(size, rounded=True):
    s = size / 32
    radius = 7 * s if rounded else 0
    stroke = 1.5 * s  # mitad del grosor (3 en el SVG)
    pts = [(x * s, y * s) for x, y in POINTS]
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            cx, cy = x + 0.5, y + 0.5
            # Fondo con esquinas redondeadas (antialias simple)
            alpha = 1.0
            if rounded:
                qx = min(cx, size - cx)
                qy = min(cy, size - cy)
                if qx < radius and qy < radius:
                    d = math.hypot(radius - qx, radius - qy)
                    alpha = max(0.0, min(1.0, radius - d + 0.5))
            d = min(dist_to_segment(cx, cy, pts[i], pts[i + 1]) for i in range(len(pts) - 1))
            line = max(0.0, min(1.0, stroke - d + 0.5))
            r, g, b = (round(BLUE[i] * (1 - line) + WHITE[i] * line) for i in range(3))
            row += bytes([r, g, b, round(alpha * 255)])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


for name, size, rounded in [("icon-192.png", 192, False), ("icon-512.png", 512, False), ("apple-touch-icon.png", 180, False)]:
    with open(os.path.join(OUT, name), "wb") as f:
        f.write(render(size, rounded))
    print("ok", name)
