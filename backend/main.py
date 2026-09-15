import os
import json
import tempfile
import time
import urllib.request
import csv
import io
import re
import hashlib
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, UploadFile, Form, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydub import AudioSegment
from pydub.silence import detect_silence
from google import genai
from typing import List, Optional

from layout_check import LAYOUT_PLACEHOLDER, analyze_layout
from prompt import DEFAULT_PROMPT_JA, LAYOUT_ISSUES_BLOCK_JA

app = FastAPI(title="Video Review API")

GEMINI_MODEL = "gemini-3.5-flash"

# 許可するオリジンは環境変数 ALLOWED_ORIGINS（カンマ区切り）で絞り込める。
# 未設定の場合は従来どおり全許可（ローカル開発・検証用）。
_allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "").strip()
ALLOWED_ORIGINS = (
    [o.strip() for o in _allowed_origins_env.split(",") if o.strip()]
    if _allowed_origins_env
    else ["*"]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    # allow_origins=["*"] と allow_credentials=True はCORS仕様上両立しない。
    # APIキーはフォームボディで送られ、Cookie等の認証情報は使わないためFalseにする。
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/default-prompt")
def get_default_prompt():
    """フロントエンドの設定画面が初期表示・リセット時に取得するデフォルトプロンプト。
    プロンプト本文をバックエンド側の1箇所（prompt.py）に集約するためのエンドポイント。"""
    return {"prompt": DEFAULT_PROMPT_JA}


# プロンプト英訳の結果キャッシュ。
# プロンプトは設定画面で変更しない限り毎回同一なので、解析のたびに再翻訳するのは
# 純粋な無駄（実測で1回あたり約7,800トークン＝全体の約14.5%）。日本語プロンプトの
# ハッシュをキーに、英訳済みテンプレート（プレースホルダは未置換の状態）を保持する。
# プロセス内メモリのみ。再起動で消えるが、その場合も一度翻訳し直せば復帰する。
_translation_cache: "OrderedDict[str, str]" = OrderedDict()
_TRANSLATION_CACHE_MAX = 20  # プロンプトを編集して試行錯誤しても膨らみすぎない上限


def get_cached_translation(prompt_ja_text: str) -> Optional[str]:
    key = hashlib.sha256(prompt_ja_text.encode("utf-8")).hexdigest()
    cached = _translation_cache.get(key)
    if cached is not None:
        _translation_cache.move_to_end(key)  # LRU: 使ったものを末尾へ
    return cached


def store_translation(prompt_ja_text: str, prompt_en_text: str) -> None:
    key = hashlib.sha256(prompt_ja_text.encode("utf-8")).hexdigest()
    _translation_cache[key] = prompt_en_text
    _translation_cache.move_to_end(key)
    while len(_translation_cache) > _TRANSLATION_CACHE_MAX:
        _translation_cache.popitem(last=False)  # 最も古いものから捨てる


# 動画のサンプリングFPS。Geminiのデフォルトは1fpsだが、テロップの切り替わりを
# 捕捉するために既定では4fps（250ms間隔）でオーバーサンプリングする。
# VIDEOトークンはfpsに比例するため、コスト調整のつまみとして設定画面から変更できる。
DEFAULT_FPS = 4.0
MIN_FPS = 0.5
MAX_FPS = 10.0


def resolve_fps(raw) -> float:
    """フォームで渡されたfpsを検証して返す。不正値は既定値にフォールバックする。"""
    if raw is None or str(raw).strip() == "":
        return DEFAULT_FPS
    try:
        value = float(raw)
    except (TypeError, ValueError):
        print(f"[fps] 数値として解釈できない値 {raw!r} を受け取りました。既定値 {DEFAULT_FPS} を使用します。")
        return DEFAULT_FPS
    if not (MIN_FPS <= value <= MAX_FPS):
        clamped = min(max(value, MIN_FPS), MAX_FPS)
        print(f"[fps] {value} は許容範囲({MIN_FPS}〜{MAX_FPS})外です。{clamped} に丸めました。")
        return clamped
    return value


def _form_flag(raw) -> bool:
    """フォームで渡されたON/OFF（"1" / "true" など）を真偽値にする。"""
    return str(raw or "").strip().lower() in ("1", "true", "on", "yes")


def summarize_usage(response, label: str) -> dict:
    """Gemini APIレスポンスから消費トークン数を取り出してログ出力し、集計用のdictを返す。
    1本あたりのコストを実測するための計測用。取得に失敗しても解析処理は止めない。"""
    empty = {"label": label, "prompt": 0, "output": 0, "thoughts": 0, "total": 0, "by_modality": {}}
    try:
        usage = getattr(response, "usage_metadata", None)
        if usage is None:
            print(f"[usage:{label}] usage_metadata is not available.")
            return empty

        # 入力の内訳（VIDEO / AUDIO / TEXT）。動画がトークンの大半を占めるため内訳が重要。
        by_modality: dict = {}
        for detail in (getattr(usage, "prompt_tokens_details", None) or []):
            modality = getattr(detail, "modality", None)
            name = getattr(modality, "value", None) or str(modality)
            by_modality[name] = by_modality.get(name, 0) + (getattr(detail, "token_count", 0) or 0)

        summary = {
            "label": label,
            "prompt": getattr(usage, "prompt_token_count", 0) or 0,
            "output": getattr(usage, "candidates_token_count", 0) or 0,
            "thoughts": getattr(usage, "thoughts_token_count", 0) or 0,
            "total": getattr(usage, "total_token_count", 0) or 0,
            "by_modality": by_modality,
        }

        modality_text = ", ".join(f"{k}={v:,}" for k, v in sorted(by_modality.items())) or "(内訳なし)"
        print(
            f"[usage:{label}] total={summary['total']:,} "
            f"(input={summary['prompt']:,} / thinking={summary['thoughts']:,} / output={summary['output']:,}) "
            f"input内訳: {modality_text}"
        )
        return summary
    except Exception as e:
        print(f"[usage:{label}] Failed to read usage_metadata ({type(e).__name__}): {e}")
        return empty


def format_time(ms: int) -> str:
    seconds = int((ms / 1000) % 60)
    minutes = int((ms / (1000 * 60)) % 60)
    return f"{minutes:02d}:{seconds:02d}"

DEFAULT_CALL_TO_ACTION = "「〇〇とコメントしてプロフィールのリンクを見てね」という構成になっているか。"


def _build_csv_export_url(url: str):
    """スプレッドシートの共有URLからCSVエクスポートURLを組み立てる。
    末尾スラッシュの有無、http/https、スキーム省略、/u/0/ 付きなど
    実際に貼り付けられ得る形をひととおり受け付ける。"""
    text = (url or "").strip()
    if not text:
        return None

    # /spreadsheets/d/<ID> を拾う（/u/0/ のようなパスが挟まっていても可）
    m = re.search(r'docs\.google\.com/spreadsheets/(?:u/\d+/)?d/([a-zA-Z0-9_-]+)', text)
    if not m:
        return None
    sheet_id = m.group(1)

    gid_match = re.search(r'[#&?]gid=([0-9]+)', text)
    gid = gid_match.group(1) if gid_match else "0"
    return f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}"


# 訴求文リストの中に混ざる「注意書き」の行を見分けるための目印。
# 実際のシートでは訴求文の直上に ⚠️注意点… という指示文が置かれており、
# これを訴求文として取り込むとAIが「注意書き」を許容パターンとして扱ってしまう。
ANNOTATION_PREFIXES = ("⚠", "※", "★", "▼", "●", "【", "!", "！")
ANNOTATION_KEYWORDS = ("注意点", "注意事項")


def _is_annotation(cell: str) -> bool:
    text = cell.lstrip()
    if text.startswith(ANNOTATION_PREFIXES):
        return True
    return any(k in text for k in ANNOTATION_KEYWORDS)


def _extract_actions(rows):
    """CSVの行データから訴求文の一覧を取り出す。

    ・「訴求文」という見出しセルを探し、その1つ下の行・同じ列からデータを読む。
      見出しが見つからない場合は従来どおり B4（4行目・B列）から読む。
    ・注意書きの行（⚠️や※で始まる、「注意点」を含む等）は訴求文ではないため除外する。
    ・空セルが2つ続いたらリストの終端とみなす。1行だけの空行では止めない
      （空行1つでリストが途中で切れてしまう不具合の対策）。
    """
    start_row, col = 3, 1  # 既定: B4から
    for r, row in enumerate(rows[:10]):
        for c, cell in enumerate(row):
            if "訴求文" in (cell or ""):
                start_row, col = r + 1, c
                break
        else:
            continue
        break

    actions, skipped = [], []
    blank_run = 0
    for row in rows[start_row:]:
        cell = row[col].strip() if len(row) > col else ""
        if not cell:
            blank_run += 1
            if blank_run >= 2:
                break  # 空行が2つ続いたら以降は無関係なテキストとみなす
            continue
        blank_run = 0
        if _is_annotation(cell):
            skipped.append(cell)
            continue
        actions.append(cell)
    return actions, skipped, start_row, col


def fetch_call_to_action_list(url: str) -> dict:
    """スプレッドシートURLから訴求文リストを取得する。

    戻り値は必ず dict:
      ok      … スプレッドシートから取得できたか
      actions … 訴求文のリスト
      text    … プロンプトに埋め込む文字列
      reason  … 失敗理由（利用者に表示する。成功時は空文字）
    取得できなかった場合は既定の1文にフォールバックするが、その事実を
    reason に載せて呼び出し側から画面に出せるようにする（従来はサーバー
    ログに出るだけで、利用者からは「機能していない」ようにしか見えなかった）。
    """
    def failed(reason: str) -> dict:
        print(f"[call_to_action] {reason}")
        return {"ok": False, "actions": [], "skipped": [], "text": DEFAULT_CALL_TO_ACTION, "reason": reason}

    if not (url or "").strip():
        return failed("スプレッドシートURLが未設定のため、既定の訴求文を使用しました。")

    export_url = _build_csv_export_url(url)
    if not export_url:
        return failed("スプレッドシートのURLとして認識できませんでした。共有リンクをそのまま貼り付けてください。")

    try:
        req = urllib.request.Request(export_url, headers={"User-Agent": "Mozilla/5.0 (video-review-tool)"})
        with urllib.request.urlopen(req, timeout=10) as response:
            content_type = response.headers.get("Content-Type", "")
            raw = response.read()
            final_url = response.geturl()
    except Exception as e:
        return failed(f"スプレッドシートを取得できませんでした（{type(e).__name__}）。URLと公開設定を確認してください。")

    # 非公開スプシの場合、GoogleはCSVではなくログインHTMLをHTTP 200で返す。
    head = raw[:512].lstrip().lower()
    if ("text/html" in content_type.lower() or head.startswith(b"<!doctype html")
            or b"<html" in head or "accounts.google.com" in final_url):
        return failed(
            "スプレッドシートが非公開のため読み取れませんでした。"
            "共有設定を「リンクを知っている全員が閲覧可」に変更してください。"
        )

    try:
        rows = list(csv.reader(io.StringIO(raw.decode("utf-8", errors="replace"))))
    except Exception as e:
        return failed(f"CSVとして解析できませんでした（{type(e).__name__}）。")

    actions, skipped, start_row, col = _extract_actions(rows)
    if not actions:
        return failed(
            f"シートは読み取れましたが、訴求文が1件も見つかりませんでした"
            f"（{len(rows)}行を確認）。訴求文を縦に並べ、見出しセルに「訴求文」と入れてください。"
        )

    print(
        f"[call_to_action] {len(actions)}件の訴求文を取得しました "
        f"(開始行={start_row + 1}, 列={chr(ord('A') + col)}, 注意書きとして除外={len(skipped)}件)"
    )
    return {
        "ok": True,
        "actions": actions,
        "skipped": skipped,
        "text": "\n".join(f"・{a}" for a in actions),
        "reason": "",
    }


@app.get("/call-to-action-check")
def call_to_action_check(url: str = ""):
    """設定画面から訴求文リストの読み取りを事前確認するための診断用エンドポイント。
    動画を1本消費しなくても、URLが正しく読めているかをその場で確認できる。"""
    result = fetch_call_to_action_list(url)
    return {"ok": result["ok"], "count": len(result["actions"]),
            "actions": result["actions"], "skipped": result.get("skipped", []),
            "reason": result["reason"]}

def detect_jetcut_issues(video_path: str) -> List[str]:
    """
    動画から無音区間を検出する。
    録画開始直後（0秒から始まる無音）と録画終了直前（末尾に達する無音）は除外する。
    """
    try:
        audio = AudioSegment.from_file(video_path)
        total_duration_ms = len(audio)

        silences = detect_silence(audio, min_silence_len=300, silence_thresh=-40)

        if not silences:
            return []

        # 先頭の無音（0msから始まるもの）を除外
        if silences and silences[0][0] == 0:
            silences = silences[1:]

        # 末尾の無音（動画の最後に到達するもの）を除外
        if silences and silences[-1][1] >= total_duration_ms - 50:
            silences = silences[:-1]

        descriptions = []
        for start_ms, end_ms in silences:
            duration = end_ms - start_ms
            if duration > 300:
                descriptions.append(
                    f"- {format_time(start_ms)}〜{format_time(end_ms)} に {duration/1000:.1f}秒の無音区間"
                )
        return descriptions
    except Exception as e:
        print(f"Audio processing error: {e}")
        return []


@app.post("/analyze")
async def analyze_video(
    video: UploadFile = File(...),
    api_key: str = Form(...),
    ng_words: str = Form("[]"),
    prompt_ja: str = Form(None),
    spreadsheet_url: str = Form(None),
    fps: str = Form(None),
    check_black_bars: str = Form(None),
    check_dead_zone: str = Form(None),
    layout_debug: str = Form(None),
):
    try:
        ng_words_list = json.loads(ng_words)
    except Exception:
        ng_words_list = []

    fps_value = resolve_fps(fps)

    client = genai.Client(api_key=api_key)

    # アップロードサイズの上限ガード（read→検査→temp作成 の順でtemp fileのleakを防ぐ）
    MAX_UPLOAD_MB = 200
    content = await video.read()
    if len(content) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail=f"動画ファイルが大きすぎます（上限 {MAX_UPLOAD_MB}MB）。ファイルを圧縮するか短く分割してください。",
        )

    with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    gemini_file = None
    video_size_mb = len(content) / (1024 * 1024)
    # inline_data方式はfps指定ができる反面、リクエスト全体で20MBという上限がある。
    # inline_dataはbase64エンコードされて約1.33倍に膨らむため、20MB基準にすると
    # 16MB前後のファイルで上限超過エラーになる。余裕をみて14MBを閾値にする。
    INLINE_THRESHOLD_MB = 14
    use_inline = video_size_mb < INLINE_THRESHOLD_MB

    try:
        # 1. 音声解析（ジェットカット検出）と、画角・デッドゾーンの検出を並行して行う
        #    （どちらもffmpegでのデコードが中心なので、待ち時間を積み重ねないため）
        with ThreadPoolExecutor(max_workers=2) as pool:
            audio_future = pool.submit(detect_jetcut_issues, tmp_path)
            layout_future = pool.submit(
                analyze_layout, tmp_path, client, GEMINI_MODEL,
                _form_flag(check_black_bars), _form_flag(check_dead_zone), _form_flag(layout_debug),
                summarize_usage,
            )
            audio_issues = audio_future.result()
            layout = layout_future.result()
        print(f"[layout] 検出結果:\n{layout['issues_text']}")
        audio_issues_text = "\n".join(audio_issues) if audio_issues else "無音区間は検出されませんでした。"
        # pydubによる無音区間の実測結果。Geminiが本当に音声を聞けているかを
        # 検証する際の「正解データ」として参照する。
        print(f"[pydub] 無音区間の実測結果:\n{audio_issues_text}")

        # 2. 動画の準備（inline_data方式 or File API方式）
        if not use_inline:
            # 閾値以上の場合はFile APIでアップロード（fpsは後段のvideo_metadataで指定する）
            gemini_file = client.files.upload(file=tmp_path)

            # PROCESSINGのまま返り続けた場合に無限ループしないよう上限を設ける
            PROCESSING_TIMEOUT_SEC = 600
            waited_sec = 0
            while gemini_file.state.name == "PROCESSING":
                if waited_sec >= PROCESSING_TIMEOUT_SEC:
                    raise HTTPException(
                        status_code=504,
                        detail=f"Geminiの動画処理が{PROCESSING_TIMEOUT_SEC // 60}分以内に完了しませんでした。時間をおいて再度お試しください。",
                    )
                time.sleep(2)
                waited_sec += 2
                gemini_file = client.files.get(name=gemini_file.name)

            if gemini_file.state.name == "FAILED":
                raise HTTPException(status_code=500, detail="Gemini video processing failed.")

        # 3. プロンプト構築（デフォルト文言の定義元は prompt.py の1箇所のみ）
        base_prompt = prompt_ja if prompt_ja else DEFAULT_PROMPT_JA

        call_to_action = fetch_call_to_action_list(spreadsheet_url)
        call_to_action_text = call_to_action["text"]

        # 4. プロンプトの英語への翻訳 (実際の指示出しは英語で行う)
        # 【重要】NGワードや訴求文などの日本語データは「翻訳前」に埋め込むと英訳されて壊れる
        # （例：「副業」→"side job"）。画面テロップとの逐語照合が必要なため、ここでは
        # プレースホルダ（{ng_words_list} 等）を残したままテンプレートだけを英訳し、
        # 実データは「翻訳後」に差し込む。
        translation_instruction = (
            "Translate the following video review instruction prompt from Japanese to English. "
            "Ensure that all nuances, formatting constraints, and strict instructions are perfectly preserved. "
            "CRITICAL - PLACEHOLDER PRESERVATION: The text contains literal placeholder tokens written "
            "exactly as {ng_words_list}, {audio_issues_text}, {call_to_action_list}, and {layout_issues_text}. "
            "You MUST output these tokens verbatim and unchanged (same ASCII characters, same curly "
            "braces). Do NOT translate, rename, reformat, or remove them, and do NOT add or remove the braces. "
            "They are substituted programmatically AFTER translation. "
            "Any Japanese text that will later appear inside these placeholders (e.g. on-screen telop NG words "
            "and call-to-action phrases) must be matched LITERALLY as Japanese; do not expect them in English. "
            "CRITICAL INSTRUCTIONS TO ADD TO THE TRANSLATED PROMPT: "
            "1. NEVER group or summarize errors (e.g., do not say 'Errors are at 0:00, 0:06, 0:37...'). "
            "2. You MUST list EVERY SINGLE occurrence of an issue individually with its exact timestamp and a concrete instruction on how to fix it. "
            "3. The correction list MUST be sorted in chronological order by timestamp (earliest first), mixing all categories together. "
            "Do NOT create per-category sections or headings. "
            "4. The final output MUST be entirely in Japanese."
        )

        # 1) テンプレートのみ英訳（プレースホルダは保持したまま）
        #    同一プロンプトの再翻訳はキャッシュで回避する（コスト・レイテンシ・失敗要因の削減）。
        required_tokens = ["{ng_words_list}", "{audio_issues_text}", "{call_to_action_list}"]
        prompt_en = get_cached_translation(base_prompt)

        if prompt_en is not None:
            print("[translation] Cache HIT — 再翻訳をスキップしました（消費トークン 0）。")
            translation_usage = {
                "label": "translation", "prompt": 0, "output": 0, "thoughts": 0,
                "total": 0, "by_modality": {}, "cached": True,
            }
        else:
            print("[translation] Cache MISS — プロンプトを英訳します。")
            translation_response = client.models.generate_content(
                model=GEMINI_MODEL,
                contents=[translation_instruction + "\n\n---\n\n" + base_prompt]
            )
            prompt_en = translation_response.text.strip()
            translation_usage = summarize_usage(translation_response, "translation")
            translation_usage["cached"] = False

            # プレースホルダが壊れていない翻訳結果だけをキャッシュする
            if all(tok in prompt_en for tok in required_tokens):
                store_translation(base_prompt, prompt_en)

        # 2) 翻訳「後」に実データを差し込む（NGワード・訴求文・無音区間を日本語のまま保持）
        if not all(tok in prompt_en for tok in required_tokens):
            # 翻訳器がプレースホルダを壊した場合は日本語テンプレートにフォールバック
            print("[translation] Placeholder token missing after translation; falling back to JA template.")
            prompt_en = base_prompt
        prompt_en = prompt_en.replace("{ng_words_list}", str(ng_words_list))
        prompt_en = prompt_en.replace("{audio_issues_text}", audio_issues_text)
        prompt_en = prompt_en.replace("{call_to_action_list}", call_to_action_text)
        if LAYOUT_PLACEHOLDER in prompt_en:
            prompt_en = prompt_en.replace(LAYOUT_PLACEHOLDER, layout["issues_text"])
        elif layout["enabled"]["black_bars"] or layout["enabled"]["dead_zone"]:
            # 設定画面で保存済みの古いプロンプトには {layout_issues_text} が無い。これを必須扱いに
            # すると翻訳結果が黙って日本語テンプレートにフォールバックし、検出結果が捨てられて
            # しまうため、必須にはせず、検出結果の節を末尾に足す。
            prompt_en += "\n\n" + LAYOUT_ISSUES_BLOCK_JA.replace(LAYOUT_PLACEHOLDER, layout["issues_text"])

        from google.genai import types

        # 4. Gemini API呼び出し（inline_data方式 or File API方式）
        gen_config = types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(
                thinking_level='high',
                include_thoughts=True
            ),
            media_resolution='MEDIA_RESOLUTION_HIGH',
            temperature=0.2  # より確実な（ブレの少ない）判定を行わせるため温度を下げる
        )

        # 動画パートの構築。inline_data / File API のどちらの経路でも video_metadata で
        # 同じfpsを指定する。以前はFile API経路にfps指定がなく、閾値を超える動画だけ
        # Geminiの既定値（1fps）で解析されていたため、ファイルサイズによってテロップの
        # 検出精度が変わってしまっていた。
        print(f"[fps] サンプリングFPS={fps_value}（{1000 / fps_value:.0f}ms間隔） mode={'inline' if use_inline else 'file_api'}")

        if use_inline:
            video_part = types.Part(
                inline_data=types.Blob(data=content, mime_type='video/mp4'),
                video_metadata=types.VideoMetadata(fps=fps_value),
            )
        else:
            video_part = types.Part(
                file_data=types.FileData(
                    file_uri=gemini_file.uri,
                    mime_type=gemini_file.mime_type or 'video/mp4',
                ),
                video_metadata=types.VideoMetadata(fps=fps_value),
            )

        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=types.Content(parts=[video_part, types.Part(text=prompt_en)]),
            config=gen_config
        )

        feedback_text = response.text.strip()
        analysis_usage = summarize_usage(response, "analysis")

        layout_usage = layout["usage"] or {
            "label": "layout", "prompt": 0, "output": 0, "thoughts": 0, "total": 0, "by_modality": {},
        }
        # 1本あたりの実測値。translation（プロンプト英訳）・analysis（動画解析）・layout（テロップ位置の検出）の合計。
        total_tokens = translation_usage["total"] + analysis_usage["total"] + layout_usage["total"]
        print(
            f"[usage:TOTAL] file={video.filename!r} size={video_size_mb:.1f}MB "
            f"mode={'inline' if use_inline else 'file_api'} fps={fps_value} "
            f"total={total_tokens:,} tokens "
            f"(translation={translation_usage['total']:,} + analysis={analysis_usage['total']:,} + layout={layout_usage['total']:,})"
        )

        return {
            "feedback": feedback_text,
            # 訴求文リストが実際に読めたかを画面に返す。読めていないまま既定の1文で
            # 判定していると「許容されるはずの訴求文が指摘される」ことになるため、
            # 利用者が気づけるようにする。
            "call_to_action": {
                "ok": call_to_action["ok"],
                "count": len(call_to_action["actions"]),
                "reason": call_to_action["reason"],
            },
            # 画角・デッドゾーンを判定できたか。判定できなかった場合に黙って省略せず、画面で気づけるようにする。
            "layout": {
                "enabled": layout["enabled"],
                "ok": layout["ok"],
                "reason": layout["reason"],
                "method": layout["method"],
                "aspect_issue": layout["aspect_issue"],
                "black_bar_count": len(layout["black_bar_issues"]),
                "dead_zone_ok": layout["dead_zone_ok"],
                "dead_zone_reason": layout["dead_zone_reason"],
                "dead_zone_count": len(layout["dead_zone_issues"]),
                "debug_images": layout["debug_images"],
            },
            "usage": {
                "total_tokens": total_tokens,
                "translation": translation_usage,
                "analysis": analysis_usage,
                "layout": layout_usage,
                "video_size_mb": round(video_size_mb, 1),
                "mode": "inline" if use_inline else "file_api",
                "fps": fps_value,
            },
        }

    except HTTPException:
        # 意図して投げたHTTPException（413/504など）はステータスコードを保ったまま返す
        raise
    except Exception as e:
        print("Error during analysis:", e)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        if gemini_file:
            try:
                client.files.delete(name=gemini_file.name)
            except Exception:
                pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
