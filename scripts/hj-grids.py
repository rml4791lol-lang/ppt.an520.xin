#!/usr/bin/env python3
# 花卷量产审片：每套风格 6 页拼 3x2 网格 → output/hj-grids/<key>.jpg，另出 8 封面总览 contact sheet。
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
PACKS = ROOT / 'public' / 'assets' / 'style-packs'
OUT = ROOT / 'output' / 'hj-grids'
OUT.mkdir(parents=True, exist_ok=True)

ARCHETYPES = ['cover', 'toc', 'section', 'content', 'data', 'process']


def thumb(path, tw):
    im = Image.open(path).convert('RGB')
    th = int(tw * im.height / im.width)
    return im.resize((tw, th), Image.LANCZOS)


def grid(key, tw=480, gap=6, bg=(17, 17, 17)):
    srcs = [PACKS / f'hj-{key}' / f'{a}.png' for a in ARCHETYPES]
    if not all(p.exists() for p in srcs):
        return None
    th = int(tw * 864 / 1536)
    W, H = 3 * tw + 4 * gap, 2 * th + 3 * gap
    canvas = Image.new('RGB', (W, H), bg)
    for i, p in enumerate(srcs):
        r, c = divmod(i, 3)
        canvas.paste(thumb(p, tw), (gap + c * (tw + gap), gap + r * (th + gap)))
    out = OUT / f'{key}.jpg'
    canvas.save(out, quality=88)
    return out


def contact(keys, tw=480, gap=6, bg=(17, 17, 17)):
    srcs = [PACKS / f'hj-{k}' / 'cover.png' for k in keys]
    srcs = [(k, p) for k, p in zip(keys, srcs) if p.exists()]
    if not srcs:
        return None
    th = int(tw * 864 / 1536)
    cols = 4
    rows = (len(srcs) + cols - 1) // cols
    W, H = cols * tw + (cols + 1) * gap, rows * th + (rows + 1) * gap
    canvas = Image.new('RGB', (W, H), bg)
    for i, (k, p) in enumerate(srcs):
        r, c = divmod(i, cols)
        canvas.paste(thumb(p, tw), (gap + c * (tw + gap), gap + r * (th + gap)))
    out = OUT / '_contact-covers.jpg'
    canvas.save(out, quality=88)
    return out


keys = sys.argv[1].split(',') if len(sys.argv) > 1 else [
    'jianyue-shangwu', 'keji-weilai', 'xueshu-yanjin', 'huichang-luyan',
    'zhengqi-huibao', 'xinxi-tubiao', 'chuangsan-jingmei', 'shuimo-guofeng',
]
done = []
for key in keys:
    out = grid(key)
    print(f'{key}: {"✓ " + str(out) if out else "缺页跳过"}')
    if out:
        done.append(key)
c = contact(done)
if c:
    print('封面总览:', c)
