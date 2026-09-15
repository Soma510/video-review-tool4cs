"""画角（黒帯）とデッドゾーンのチェック。

入力はCapCut編集画面の画面録画。録画画面の中から9:16のプレビュー枠（キャンバス）を
特定し、その内側で次の2点を判定する。
  ・黒帯：素材がキャンバスに合っておらず、上下または左右に純黒の帯が出ている
  ・デッドゾーン：TikTok/InstagramのUIに隠れる位置にテロップが入っている

位置関係の線引きはすべてこのモジュールのコードで行い、AIには判断させない
（ピクセル単位の見た目判定はAIが不安定なため）。Geminiには「テロップがどこにあるか」
だけを答えさせる。Geminiの座標出力(box_2d)は公式には画像のみ対応なので、
動画ではなく抽出した静止画を送る。
"""

import base64
import io
import json
import math
import os
import subprocess
import tempfile
import traceback
from typing import Callable, List, Optional

import numpy as np
from PIL import Image, ImageDraw

LAYOUT_PLACEHOLDER = "{layout_issues_text}"

CANVAS_W, CANVAS_H = 1080, 1920
CANVAS_ASPECT = CANVAS_W / CANVAS_H

WORK_HEIGHT = 1280           # 解析用に縮小するフレームの高さ
SAMPLE_FPS = 2.0             # 1秒あたりに抽出するコマ数
MAX_SAMPLE_FRAMES = 180      # 長い動画でも処理量が膨らまないようにする上限

BLACK_LEVEL = 20             # これ以下の輝度を「純黒」とみなす（圧縮ノイズを許容）
BG_TOLERANCE = 16            # プレビュー周囲の背景色との差がこれ以下なら「背景」とみなす
VISIBLE_BOUNDARY_BG = 26     # プレビュー周囲の背景がこれより明るければ、黒い帯（圧縮後の輝度0〜8程度）との境目が見える
WIDE_CANVAS_ASPECT = 0.7     # 映像の範囲の縦横比がこれ以上なら、キャンバス自体が9:16より横長

# 黒帯
BAR_MIN_RATIO = 0.03         # キャンバスの幅（高さ）の3%以上で黒帯とみなす
BAR_MAX_RATIO = 0.40         # これを超える帯は暗転・真っ黒な画面とみなして判定に使わない
BAR_BLACK_FRACTION = 0.85    # 帯の85%以上が純黒なら黒帯（帯の上にテロップが載っていても検知する）
BAR_EDGE_FRACTION = 0.6      # 帯の境界の列（行）自体もこの割合以上が純黒であること
BAR_SYMMETRY = 0.5           # 両側の帯の幅の比がこれ以上なら対称とみなす
BAR_MIN_SECONDS = 1.0        # 1秒以上続いたら違反

# デッドゾーン（1080×1920基準）。右下の縦長部分は「下から1080px × 右端から300px」。
# 重なりのない5つの長方形に分割しており、合計がデッドゾーン全体になる。
DEAD_ZONES = [
    ("上部", (0, 0, 1080, 250)),
    ("左端", (0, 250, 120, 1440)),
    ("右端", (960, 250, 1080, 840)),
    ("右下（いいね・コメントボタン付近）", (780, 840, 1080, 1920)),
    ("下部（キャプション付近）", (0, 1440, 780, 1920)),
]
DEAD_ZONE_RATIO = 0.2        # テロップ面積の2割以上が入ったら違反
TELOP_MERGE_SECONDS = 2.0    # 同じテロップがこの間隔以内で続けば1件にまとめる
MAX_TELOP_FRAMES = 40        # Geminiに送る静止画の上限（コストの上限）
TELOP_IMAGE_SIZE = (432, 768)
MAX_DEBUG_IMAGES = 6

NOT_RUN_TEXT = "画角・デッドゾーンのチェックは実行していません。この項目について指摘しないでください。"

TELOP_INSTRUCTION = """You will receive {count} images. Each image is the full 9:16 canvas of one frame of a vertical short video.
For each image, list every TELOP: a caption or subtitle text overlay that was added in the video editor on top of the footage.
Do NOT include:
- text that is part of the underlying footage (for example text inside a phone screenshot or an app screen shown in the video, signs, packaging)
- stickers, emoji, arrows, icons, logos, or pictures
For each telop return:
- text: the telop text exactly as written (keep Japanese as-is)
- box_2d: [ymin, xmin, ymax, xmax] normalized to 0-1000 relative to that image, tightly enclosing the characters of the whole telop block (all lines of the same caption together, including outline and shadow, but excluding any wide background band)
Return one entry per image, using image_index exactly as labeled. If an image has no telop, return an empty telops list.
Report positions only. Do not judge whether the layout is good or bad."""

TELOP_SCHEMA = {
    "type": "object",
    "properties": {
        "images": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "image_index": {"type": "integer"},
                    "telops": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": {"type": "string"},
                                "box_2d": {"type": "array", "items": {"type": "integer"}},
                            },
                            "required": ["text", "box_2d"],
                        },
                    },
                },
                "required": ["image_index", "telops"],
            },
        },
    },
    "required": ["images"],
}


def _fmt(seconds: float) -> str:
    total = int(seconds)
    return f"{total // 60:02d}:{total % 60:02d}"


def _time_range(start: float, end: float) -> str:
    return _fmt(start) if int(start) == int(end) else f"{_fmt(start)}〜{_fmt(end)}"


# ---------------------------------------------------------------- フレーム抽出

def _probe_duration(video_path: str) -> Optional[float]:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video_path],
            capture_output=True, text=True, timeout=30,
        )
        return float(out.stdout.strip())
    except Exception:
        return None


def extract_frames(video_path: str, workdir: str):
    """動画から解析用の静止画を抽出し、(ファイルパス一覧, 抽出fps, (幅, 高さ)) を返す。
    i番目のコマは動画の i / fps 秒の位置に対応する。"""
    duration = _probe_duration(video_path)
    fps = SAMPLE_FPS
    if duration and duration * fps > MAX_SAMPLE_FRAMES:
        fps = MAX_SAMPLE_FRAMES / duration
    subprocess.run(
        ["ffmpeg", "-v", "error", "-i", video_path,
         "-vf", f"fps={fps},scale=-2:{WORK_HEIGHT}",
         "-frames:v", str(MAX_SAMPLE_FRAMES), "-q:v", "2",
         os.path.join(workdir, "f_%05d.jpg")],
        check=True, capture_output=True, timeout=300,
    )
    paths = sorted(os.path.join(workdir, n) for n in os.listdir(workdir) if n.startswith("f_"))
    if not paths:
        raise RuntimeError("動画からコマを抽出できませんでした。")
    with Image.open(paths[0]) as im:
        size = im.size
    return paths, fps, size


def _luma(path: str) -> np.ndarray:
    with Image.open(path) as im:
        return np.asarray(im.convert("L"), dtype=np.int16)


# ---------------------------------------------------------- プレビュー枠の特定

def _edge_slices(width: int):
    """プレビュー枠の外側（CapCutのプレビュー領域の左右の余白）に当たる縦長の帯。"""
    def band(a, b):
        start = int(width * a)
        return slice(start, max(int(width * b), start + 1))
    return band(0.02, 0.10), band(0.90, 0.98)


def _close_gaps(mask: np.ndarray, max_gap: int) -> np.ndarray:
    mask = mask.copy()
    idx = np.nonzero(mask)[0]
    for start, gap in zip(idx[:-1], np.diff(idx)):
        if 1 < gap <= max_gap + 1:
            mask[start:start + gap] = True
    return mask


def _longest_run(mask: np.ndarray):
    best, start = None, None
    for i, value in enumerate(np.append(mask, False)):
        if value and start is None:
            start = i
        elif not value and start is not None:
            if best is None or i - start > best[1] - best[0]:
                best = (start, i)
            start = None
    return best


def _find_stage_band(paths: List[str], size):
    """CapCutのプレビュー領域（上のツールバーと下の再生操作の行に挟まれた帯）を探す。

    ツールバーや再生操作の行は左右の端にアイコンがあるため、端の帯が一様にならない。
    プレビュー領域の行だけは、左右の端が常に同じ背景色で一様になる。
    この性質で行を判定するので、端末の解像度やレイアウトの細かな違いに依存しない。"""
    width, height = size
    left, right = _edge_slices(width)
    uniform_count = np.zeros(height, dtype=np.int32)
    mean_sum = np.zeros(height)
    mean_min = np.full(height, np.inf)
    mean_max = np.full(height, -np.inf)
    for path in paths:
        luma = _luma(path)
        sl, sr = luma[:, left], luma[:, right]
        ml, mr = sl.mean(axis=1), sr.mean(axis=1)
        uniform_count += (sl.std(axis=1) < 6) & (sr.std(axis=1) < 6) & (np.abs(ml - mr) < 8)
        rowmean = (ml + mr) / 2
        mean_sum += rowmean
        np.minimum(mean_min, rowmean, out=mean_min)
        np.maximum(mean_max, rowmean, out=mean_max)
    n = len(paths)
    rows = (uniform_count >= 0.7 * n) & ((mean_max - mean_min) < 12)
    run = _longest_run(_close_gaps(rows, 4))
    if run is None:
        return None
    y0, y1 = run
    return int(y0), int(y1), float(np.median(mean_sum[y0:y1] / n))


def _first_run(mask: np.ndarray, min_len: float, max_start: float):
    """上から順に見て、十分な長さがある最初の連続区間。"""
    start = None
    for i, value in enumerate(np.append(mask, False)):
        if value and start is None:
            start = i
        elif not value and start is not None:
            if i - start >= min_len and start <= max_start:
                return start, i
            start = None
    return None


def _detect_wide_canvas(paths: List[str], size):
    """プレビュー領域が見つからないとき、キャンバス自体が9:16より横長になっていないかを確かめる。

    1:1や4:5などのキャンバスは画面の横幅いっぱいまで広がり、プレビュー領域の左右の余白が
    消えるため、通常の方法ではプレビュー領域を見つけられない。画面の上側で、映像が映っている
    範囲の縦横比を直接測り、明らかに横長ならキャンバス比率の問題とみなす。
    9:16のキャンバスを全画面表示しているだけの場合は縦横比が約0.56になるので、ここでは拾わない。"""
    width, height = size
    n = len(paths)
    row_hits = np.zeros(height, dtype=np.int32)
    lit_count = np.zeros((height, width), dtype=np.uint16)
    for path in paths:
        lit = _luma(path) > BLACK_LEVEL + BG_TOLERANCE
        lit_count += lit.astype(np.uint16)
        row_hits += lit.mean(axis=1) >= 0.5
    # 上から最初に現れる、映像が横に広がった行の連なり（その下にあるタイムラインは対象外）
    run = _first_run(_close_gaps(row_hits >= 0.3 * n, 4), min_len=0.2 * height, max_start=0.6 * height)
    if run is None:
        return None
    y0, y1 = run
    cols = np.nonzero((lit_count[y0:y1] >= 0.3 * n).mean(axis=0) >= 0.5)[0]
    if cols.size == 0 or (cols[-1] + 1 - cols[0]) / (y1 - y0) < WIDE_CANVAS_ASPECT:
        return None
    return float(cols[0]), float(y0), float(cols[-1] + 1), float(y1)


def _canvas_fail(reason: str, stage=None) -> dict:
    return {"ok": False, "reason": reason, "box": None, "method": None,
            "stage": stage, "aspect_issue": False, "valid": []}


def detect_canvas(paths: List[str], size) -> dict:
    """録画画面の中の9:16キャンバスの位置を特定する。

    CapCutのキャンバス背景とプレビュー領域の背景はどちらも黒のことが多く、黒帯が出ている
    動画ではキャンバスの縁が画素として見えない。そのため、動画全体で映像が映った範囲の
    外接矩形を求め、それがプレビューの縦幅（または横幅）いっぱいに届いている辺を基準に、
    9:16の比率からキャンバスの大きさを割り出す。"""
    width, height = size
    if width > height:
        return _canvas_fail("横向きの動画には対応していません。")

    # アップロードされた動画そのものが9:16なら、書き出した完成動画とみなして画面全体を使う
    if abs((width / height) / CANVAS_ASPECT - 1) <= 0.03:
        return {"ok": True, "reason": "", "box": (0.0, 0.0, float(width), float(height)),
                "method": "full_frame", "stage": None, "aspect_issue": False,
                "valid": list(range(len(paths)))}

    stage = _find_stage_band(paths, size)
    if stage is None or (stage[1] - stage[0]) < 0.25 * height:
        wide = _detect_wide_canvas(paths, size)
        if wide is not None:
            return {"ok": True, "reason": "", "box": wide, "method": "wide_canvas", "stage": None,
                    "aspect_issue": True, "valid": list(range(len(paths)))}
        return _canvas_fail("CapCutのプレビュー領域を見つけられませんでした。", stage)
    sy0, sy1, bg = stage
    band_h = sy1 - sy0
    left, right = _edge_slices(width)

    count = np.zeros((band_h, width), dtype=np.uint16)
    valid, content_widths = [], []
    for i, path in enumerate(paths):
        band = _luma(path)[sy0:sy1]
        edges = np.concatenate([band[:, left].ravel(), band[:, right].ravel()])
        if abs(edges.mean() - bg) >= 8 or edges.std() >= 10:
            continue  # 全画面プレビューやポップアップなど、レイアウトが違うコマは使わない
        nonbg = np.abs(band - bg) > BG_TOLERANCE
        count += nonbg.astype(np.uint16)
        valid.append(i)
        cols = np.nonzero(nonbg.sum(axis=0) >= max(3, 0.01 * band_h))[0]
        content_widths.append(int(cols[-1] - cols[0] + 1) if cols.size else 0)

    if len(valid) < max(3, 0.3 * len(paths)):
        return _canvas_fail("録画中にCapCutの画面レイアウトが大きく変わっているため、プレビュー枠を特定できませんでした。", stage)

    union = count >= max(2, math.ceil(0.03 * len(valid)))
    cols = np.nonzero(union.sum(axis=0) >= max(3, 0.01 * band_h))[0]
    rows = np.nonzero(union.sum(axis=1) >= max(3, 0.01 * width))[0]
    if cols.size == 0 or rows.size == 0:
        return _canvas_fail("プレビューの中に映像が見つかりませんでした。", stage)

    ux0, ux1 = float(cols[0]), float(cols[-1] + 1)
    uy0, uy1 = float(sy0 + rows[0]), float(sy0 + rows[-1] + 1)
    uw, uh = ux1 - ux0, uy1 - uy0
    fit_h = min(band_h, width / CANVAS_ASPECT)
    fit_w = fit_h * CANVAS_ASPECT
    cx, cy = width / 2, (sy0 + sy1) / 2

    # 9:16のキャンバスでは入り切らない横幅の映像が繰り返し映る → キャンバス比率自体が違う
    aspect_issue = sum(1 for w in content_widths if w > 1.2 * fit_w) >= 0.2 * len(valid)

    if bg >= VISIBLE_BOUNDARY_BG:
        # プレビュー領域の背景が黒くない：キャンバス（黒い帯も含む）の縁がそのまま見える
        box, method = (ux0, uy0, ux1, uy1), "visible_boundary"
        aspect_issue = aspect_issue or abs((uw / uh) / CANVAS_ASPECT - 1) > 0.06
    elif uh >= 0.85 * fit_h:
        # 映像がプレビューの縦幅いっぱいに届いている：高さからキャンバスの幅を決める
        cw = uh * CANVAS_ASPECT
        box, method = (cx - cw / 2, uy0, cx + cw / 2, uy1), "content_height"
    elif 0.85 * fit_w <= uw <= 1.15 * fit_w:
        # 横幅いっぱいに届いている（上下に黒帯がある動画など）：幅からキャンバスの高さを決める
        ch = uw / CANVAS_ASPECT
        box, method = (cx - uw / 2, cy - ch / 2, cx + uw / 2, cy + ch / 2), "content_width"
    else:
        return _canvas_fail("映像がプレビュー枠の縁まで届いておらず、枠の大きさを特定できませんでした。", stage)

    if box[1] < sy0 - 0.02 * height or box[3] > sy1 + 0.02 * height or box[0] < -0.01 * width or box[2] > 1.01 * width:
        return _canvas_fail("推定したプレビュー枠がプレビュー領域からはみ出しているため、判定を見送りました。", stage)

    return {"ok": True, "reason": "", "box": box, "method": method, "stage": stage,
            "aspect_issue": bool(aspect_issue), "valid": valid}


# ------------------------------------------------------------------ 黒帯

def _bar_extent(fractions: np.ndarray) -> int:
    """端から数えて、何列（行）ぶんが黒帯とみなせるか。
    端のわずかなズレや帯に載ったテロップで途切れないよう、端からの累積で判定する。"""
    band = np.cumsum(fractions) / np.arange(1, fractions.size + 1)
    idx = np.nonzero((band >= BAR_BLACK_FRACTION) & (fractions >= BAR_EDGE_FRACTION))[0]
    return int(idx[-1]) + 1 if idx.size else 0


def _is_bar_pair(a: int, b: int, length: int) -> bool:
    low, high = min(a, b), max(a, b)
    return low >= BAR_MIN_RATIO * length and low / high >= BAR_SYMMETRY


def measure_bars(crop: np.ndarray) -> Optional[dict]:
    """キャンバス内の上下左右の黒帯の幅を測る。暗転や真っ黒な画面なら None。"""
    ch, cw = crop.shape
    black = crop <= BLACK_LEVEL
    col, row = black.mean(axis=0), black.mean(axis=1)
    left, right = _bar_extent(col), _bar_extent(col[::-1])
    top, bottom = _bar_extent(row), _bar_extent(row[::-1])
    if max(left, right) >= BAR_MAX_RATIO * cw or max(top, bottom) >= BAR_MAX_RATIO * ch:
        return None
    inner = black[top:ch - bottom, left:cw - right]
    if inner.size == 0 or 1 - inner.mean() < 0.15:
        return None
    return {
        "left": left, "right": right, "top": top, "bottom": bottom,
        "pillarbox": _is_bar_pair(left, right, cw),
        "letterbox": _is_bar_pair(top, bottom, ch),
        "side_ratio": (left + right) / 2 / cw,
        "vertical_ratio": (top + bottom) / 2 / ch,
    }


def _flag_segments(flagged: List[int], fps: float, min_seconds: float):
    """黒帯と判定されたコマ番号を、連続する区間にまとめる（1コマの抜けは許容）。"""
    segments = []
    for idx in sorted(flagged):
        if segments and idx - segments[-1][1] <= 2:
            segments[-1][1] = idx
        else:
            segments.append([idx, idx])
    return [(a, b) for a, b in segments if (b - a + 1) / fps >= min_seconds]


# -------------------------------------------------------------- デッドゾーン

def _intersection(a, b) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


def dead_zone_overlap(rect):
    """テロップの矩形（1080×1920基準）のうち、デッドゾーンに入っている面積の割合と、
    重なっているゾーン名（重なりの大きい順）を返す。"""
    area = (rect[2] - rect[0]) * (rect[3] - rect[1])
    parts = [(name, _intersection(rect, zone)) for name, zone in DEAD_ZONES]
    dead = sum(v for _, v in parts)
    names = [name for name, v in sorted(parts, key=lambda p: -p[1]) if v > 0]
    return (dead / area if area > 0 else 0.0), names


def _parse_telops(data, count: int):
    """Geminiの応答を検証し、画像ごとのテロップ一覧（1080×1920基準の矩形）に変換する。"""
    per_image = [[] for _ in range(count)]
    for entry in (data or {}).get("images", []) or []:
        k = entry.get("image_index")
        if not isinstance(k, int) or not 0 <= k < count:
            continue
        for telop in entry.get("telops") or []:
            box = telop.get("box_2d")
            if not (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box)):
                continue
            ymin, xmin, ymax, xmax = [min(max(float(v), 0.0), 1000.0) for v in box]
            if ymax <= ymin or xmax <= xmin:
                continue
            rect = (xmin / 1000 * CANVAS_W, ymin / 1000 * CANVAS_H,
                    xmax / 1000 * CANVAS_W, ymax / 1000 * CANVAS_H)
            area = (rect[2] - rect[0]) * (rect[3] - rect[1])
            if not 0.0005 * CANVAS_W * CANVAS_H <= area <= 0.6 * CANVAS_W * CANVAS_H:
                continue  # 極端に小さい・大きい枠はテロップではないとみなす
            per_image[k].append({"text": str(telop.get("text") or "").strip(), "rect": rect})
    return per_image


def detect_telops(client, model: str, images: List[bytes]):
    """キャンバスの静止画をまとめてGeminiに送り、テロップの位置だけを答えさせる。"""
    from google.genai import types

    parts = [types.Part(text=TELOP_INSTRUCTION.format(count=len(images)))]
    for k, data in enumerate(images):
        parts.append(types.Part(text=f"image_index={k}"))
        parts.append(types.Part.from_bytes(data=data, mime_type="image/jpeg"))
    config = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_json_schema=TELOP_SCHEMA,
        temperature=0,
        thinking_config=types.ThinkingConfig(thinking_level="low"),
    )
    response = client.models.generate_content(model=model, contents=types.Content(parts=parts), config=config)
    return _parse_telops(json.loads(response.text), len(images)), response


def _dead_zone_segments(frame_indices: List[int], per_image, fps: float):
    segments = []
    for k, idx in enumerate(frame_indices):
        t = idx / fps
        for telop in per_image[k]:
            ratio, names = dead_zone_overlap(telop["rect"])
            if ratio < DEAD_ZONE_RATIO:
                continue
            key = "".join(telop["text"].split())
            seg = next((s for s in reversed(segments)
                        if s["key"] == key and t - s["end"] <= TELOP_MERGE_SECONDS), None)
            if seg is None:
                seg = {"key": key, "text": telop["text"], "start": t, "end": t,
                       "ratio": 0.0, "zones": [], "frame": idx}
                segments.append(seg)
            seg["end"] = t
            if ratio > seg["ratio"]:
                seg["ratio"], seg["frame"] = ratio, idx
            seg["zones"] += [n for n in names if n not in seg["zones"]]
    return segments


# ------------------------------------------------------------ 判定根拠の画像

def _canvas_jpeg(path: str, box, size, quality: int) -> bytes:
    with Image.open(path) as im:
        crop = im.convert("RGB").crop(tuple(int(round(v)) for v in box))
    buf = io.BytesIO()
    crop.resize(size, Image.BILINEAR).save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def _debug_image(path: str, title: str, canvas: Optional[dict], bars=None, telops=None) -> str:
    """判定に使ったコマに、検出したプレビュー枠・デッドゾーン・黒帯・テロップ枠を描き込む。"""
    with Image.open(path) as im:
        img = im.convert("RGB")
    draw = ImageDraw.Draw(img, "RGBA")
    width = img.size[0]
    stage = canvas.get("stage") if canvas else None
    if stage:
        draw.rectangle([0, stage[0], width - 1, stage[1]], outline=(170, 170, 170, 255), width=2)
    box = canvas.get("box") if canvas else None
    if box:
        x0, y0, x1, y1 = box
        sx, sy = (x1 - x0) / CANVAS_W, (y1 - y0) / CANVAS_H
        for _, (a, b, c, d) in DEAD_ZONES:
            draw.rectangle([x0 + a * sx, y0 + b * sy, x0 + c * sx, y0 + d * sy], fill=(255, 0, 0, 55))
        draw.rectangle([x0, y0, x1, y1], outline=(0, 220, 255, 255), width=3)
        if bars:
            magenta = (255, 0, 255, 255)
            if bars["left"]:
                draw.line([x0 + bars["left"], y0, x0 + bars["left"], y1], fill=magenta, width=3)
            if bars["right"]:
                draw.line([x1 - bars["right"], y0, x1 - bars["right"], y1], fill=magenta, width=3)
            if bars["top"]:
                draw.line([x0, y0 + bars["top"], x1, y0 + bars["top"]], fill=magenta, width=3)
            if bars["bottom"]:
                draw.line([x0, y1 - bars["bottom"], x1, y1 - bars["bottom"]], fill=magenta, width=3)
        for telop in telops or []:
            rx0, ry0, rx1, ry1 = telop["rect"]
            ratio, _ = dead_zone_overlap(telop["rect"])
            color = (255, 40, 40, 255) if ratio >= DEAD_ZONE_RATIO else (255, 220, 0, 255)
            draw.rectangle([x0 + rx0 * sx, y0 + ry0 * sy, x0 + rx1 * sx, y0 + ry1 * sy], outline=color, width=4)
    draw.rectangle([0, 0, width, 30], fill=(0, 0, 0, 190))
    draw.text((8, 8), title, fill=(255, 255, 255, 255))
    img.thumbnail((360, 800))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return base64.b64encode(buf.getvalue()).decode("ascii")


# ------------------------------------------------------------------ 本体

def _issues_text(result: dict) -> str:
    enabled = result["enabled"]
    if not (enabled["black_bars"] or enabled["dead_zone"]):
        return NOT_RUN_TEXT
    if not result["ok"]:
        return f"今回は画角・デッドゾーンを判定していません（{result['reason']}）。この項目について指摘しないでください。"
    lines = []
    if enabled["black_bars"]:
        if result["aspect_issue"]:
            lines.append("- 動画全体 キャンバスの比率が9:16になっていない可能性があります。CapCutの「比率」を9:16にしてください。")
        for issue in result["black_bar_issues"]:
            lines.append(issue["message"])
        if not lines:
            lines.append("- 黒帯（縦横比のミス）は検出されませんでした。")
    if enabled["dead_zone"]:
        if not result["dead_zone_ok"]:
            lines.append(f"- デッドゾーンは判定していません（{result['dead_zone_reason']}）。")
        elif result["dead_zone_issues"]:
            lines += [issue["message"] for issue in result["dead_zone_issues"]]
        else:
            lines.append("- デッドゾーンに入っているテロップは検出されませんでした。")
    return "\n".join(lines)


def analyze_layout(video_path: str, client, model: str, check_black_bars: bool, check_dead_zone: bool,
                   debug: bool, usage_summarizer: Callable) -> dict:
    """画角（黒帯）とデッドゾーンをチェックする。

    どんな失敗でも例外を外に出さず、判定しなかった理由を reason に入れて返す
    （本体の添削を止めないため。また、黙って判定を省かず画面で気づけるようにするため）。"""
    result = {
        "enabled": {"black_bars": bool(check_black_bars), "dead_zone": bool(check_dead_zone)},
        "ok": False, "reason": "", "method": None, "aspect_issue": False,
        "black_bar_issues": [], "dead_zone_ok": False, "dead_zone_reason": "",
        "dead_zone_issues": [], "usage": None, "debug_images": [], "issues_text": "",
    }
    if not (check_black_bars or check_dead_zone):
        result["issues_text"] = NOT_RUN_TEXT
        return result

    try:
        with tempfile.TemporaryDirectory() as workdir:
            paths, fps, size = extract_frames(video_path, workdir)
            canvas = detect_canvas(paths, size)
            print(f"[layout] frames={len(paths)} fps={fps:.2f} size={size} canvas_ok={canvas['ok']} "
                  f"method={canvas['method']} box={canvas['box']} stage={canvas['stage']} "
                  f"valid={len(canvas['valid'])} aspect_issue={canvas['aspect_issue']} reason={canvas['reason']!r}")
            if not canvas["ok"]:
                result["reason"] = canvas["reason"]
                if debug:
                    mid = paths[len(paths) // 2]
                    result["debug_images"].append({
                        "label": "プレビュー枠を特定できなかったコマ",
                        "image": _debug_image(mid, "canvas NOT found", canvas),
                    })
                return result

            result["ok"] = True
            result["method"] = canvas["method"]
            result["aspect_issue"] = canvas["aspect_issue"]
            box = canvas["box"]
            ix0, iy0, ix1, iy1 = (int(round(v)) for v in box)

            # キャンバス内の黒帯を測りつつ、テロップ判定に送るコマを選ぶ（画面の変化が小さいコマは除く）
            bars_by_frame, pillar_frames, letter_frames, candidates = {}, [], [], []
            last_thumb = None
            for i in canvas["valid"]:
                luma = _luma(paths[i])
                crop = luma[max(iy0, 0):iy1, max(ix0, 0):ix1]
                if crop.size == 0:
                    continue
                bars = measure_bars(crop)
                if bars is not None:
                    bars_by_frame[i] = bars
                    if bars["pillarbox"]:
                        pillar_frames.append(i)
                    if bars["letterbox"]:
                        letter_frames.append(i)
                thumb = np.asarray(Image.fromarray(crop.astype(np.uint8)).resize((18, 32)), dtype=np.int16)
                if last_thumb is None or np.abs(thumb - last_thumb).mean() > 4:
                    candidates.append(i)
                    last_thumb = thumb

            if check_black_bars and not result["aspect_issue"]:
                for kind, frames, key, dim, label in (
                    ("pillarbox", pillar_frames, "side_ratio", CANVAS_W, "左右"),
                    ("letterbox", letter_frames, "vertical_ratio", CANVAS_H, "上下"),
                ):
                    for a, b in _flag_segments(frames, fps, BAR_MIN_SECONDS):
                        ratios = [bars_by_frame[i][key] for i in frames if a <= i <= b]
                        ratio = float(np.median(ratios))
                        start, end = a / fps, (b + 1) / fps
                        cause = ("素材がキャンバスより縦長のため、横幅いっぱいまで拡大されていません"
                                 if kind == "pillarbox" else
                                 "素材がキャンバスより横長のため、縦幅いっぱいまで拡大されていません")
                        result["black_bar_issues"].append({
                            "kind": kind, "start": start, "end": end, "ratio": ratio, "frame": (a + b) // 2,
                            "message": f"- {_time_range(start, end)} {label}に黒帯があります（{label}それぞれ約"
                                       f"{round(ratio * dim)}px、キャンバスの約{round(ratio * 100)}%）。{cause}。",
                        })
                result["black_bar_issues"].sort(key=lambda issue: issue["start"])

            per_image, selected = [], []
            if check_dead_zone:
                if result["aspect_issue"]:
                    result["dead_zone_reason"] = "キャンバスの比率が9:16ではないため"
                elif not candidates:
                    result["dead_zone_reason"] = "判定に使えるコマがありませんでした"
                else:
                    selected = candidates
                    if len(selected) > MAX_TELOP_FRAMES:
                        picks = np.linspace(0, len(selected) - 1, MAX_TELOP_FRAMES).round().astype(int)
                        selected = [selected[p] for p in sorted(set(picks))]
                    images = [_canvas_jpeg(paths[i], box, TELOP_IMAGE_SIZE, 85) for i in selected]
                    try:
                        per_image, response = detect_telops(client, model, images)
                        result["usage"] = usage_summarizer(response, "layout")
                        result["dead_zone_ok"] = True
                        for seg in _dead_zone_segments(selected, per_image, fps):
                            text = seg["text"] if len(seg["text"]) <= 20 else seg["text"][:20] + "…"
                            seg["message"] = (f"- {_time_range(seg['start'], seg['end'])} テロップ「{text}」の約"
                                              f"{round(seg['ratio'] * 100)}%が{'・'.join(seg['zones'])}の"
                                              f"デッドゾーンに入っています。")
                            del seg["key"]
                            result["dead_zone_issues"].append(seg)
                        print(f"[layout] telop frames sent={len(selected)} dead_zone_issues={len(result['dead_zone_issues'])}")
                    except Exception as e:
                        print(f"[layout] telop detection failed ({type(e).__name__}): {e}")
                        result["dead_zone_reason"] = f"テロップの位置を取得できませんでした（{type(e).__name__}）"

            if debug:
                telops_by_frame = {idx: per_image[k] for k, idx in enumerate(selected)} if per_image else {}
                shots = [(canvas["valid"][0], "プレビュー枠の検出結果")]
                shots += [(issue["frame"], f"黒帯 {_time_range(issue['start'], issue['end'])}")
                          for issue in result["black_bar_issues"]]
                shots += [(seg["frame"], f"デッドゾーン {_time_range(seg['start'], seg['end'])}")
                          for seg in result["dead_zone_issues"]]
                for idx, label in shots[:MAX_DEBUG_IMAGES]:
                    title = f"t={_fmt(idx / fps)} method={canvas['method']}"
                    result["debug_images"].append({
                        "label": label,
                        "image": _debug_image(paths[idx], title, canvas, bars_by_frame.get(idx),
                                              telops_by_frame.get(idx)),
                    })
    except Exception as e:
        traceback.print_exc()
        result["ok"] = False
        result["reason"] = f"画角・デッドゾーンのチェック中にエラーが発生しました（{type(e).__name__}）"
    finally:
        result["issues_text"] = _issues_text(result)

    return result
