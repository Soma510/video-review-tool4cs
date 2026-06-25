import os
import json
import tempfile
import time
import urllib.request
import csv
import io
import re
from fastapi import FastAPI, UploadFile, Form, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydub import AudioSegment
from pydub.silence import detect_silence
from google import genai
from typing import List

app = FastAPI(title="Video Review API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    # allow_origins=["*"] と allow_credentials=True はCORS仕様上両立しない。
    # APIキーはフォームボディで送られ、Cookie等の認証情報は使わないためFalseにする。
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def format_time(ms: int) -> str:
    seconds = int((ms / 1000) % 60)
    minutes = int((ms / (1000 * 60)) % 60)
    return f"{minutes:02d}:{seconds:02d}"

def fetch_call_to_action_list(url: str) -> str:
    """スプレッドシートURLからCSVとしてデータを取得し、訴求文のリストを文字列として返す。
    訴求文はB列の4行目以降（B4〜）に並んでおり、B列が空になった時点で終端とみなす
    （B11以降に入り得る無関係なテキストを取り込まないため）。
    取得・解析に失敗した場合は default_action にフォールバックし、理由をログ出力する。"""
    default_action = "「〇〇とコメントしてプロフィールのリンクを見てね」という構成になっているか。"
    if not url:
        print("[call_to_action] No spreadsheet URL provided; using default action.")
        return default_action

    try:
        base_match = re.search(r'(https://docs\.google\.com/spreadsheets/d/[a-zA-Z0-9-_]+)/', url)
        if not base_match:
            print(f"[call_to_action] URL did not match expected spreadsheet pattern: {url!r}; using default.")
            return default_action

        base_url = base_match.group(1)
        gid_match = re.search(r'gid=([0-9]+)', url)
        gid = gid_match.group(1) if gid_match else "0"

        export_url = f"{base_url}/export?format=csv&gid={gid}"

        req = urllib.request.Request(
            export_url,
            headers={"User-Agent": "Mozilla/5.0 (video-review-tool)"}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            content_type = response.headers.get("Content-Type", "")
            raw = response.read()
            final_url = response.geturl()

        # 非公開スプシの場合、GoogleはCSVではなくログインHTMLをHTTP 200で返す。
        # これを検出してフォールバックし、原因が分かるようにログを残す。
        head = raw[:512].lstrip().lower()
        looks_like_html = (
            "text/html" in content_type.lower()
            or head.startswith(b"<!doctype html")
            or b"<html" in head
            or "accounts.google.com" in final_url
        )
        if looks_like_html:
            print(
                "[call_to_action] Received an HTML/login response instead of CSV "
                f"(Content-Type={content_type!r}, final_url={final_url!r}). "
                "The spreadsheet is likely NOT shared as 'anyone with the link'. Using default action."
            )
            return default_action

        csv_data = raw.decode("utf-8", errors="replace")
        reader = csv.reader(io.StringIO(csv_data))
        lines = list(reader)

        actions = []
        for row in lines[3:]:  # 4行目（B4）以降を対象
            if len(row) < 2:
                break  # B列が存在しない行に到達したら終了
            cell = row[1].strip()
            if not cell:
                break  # B列が空＝訴求文リストの終端（B11以降の無関係テキストを除外）
            actions.append(f"・{cell}")

        if not actions:
            print(
                f"[call_to_action] CSV parsed but no action rows found in column B from row 4 "
                f"(rows={len(lines)}). Using default action."
            )
            return default_action

        return "\n".join(actions)

    except Exception as e:
        print(f"[call_to_action] Failed to fetch/parse spreadsheet ({type(e).__name__}): {e}. Using default action.")
        return default_action


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
    spreadsheet_url: str = Form(None)
):
    try:
        ng_words_list = json.loads(ng_words)
    except Exception:
        ng_words_list = []

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
    use_inline = video_size_mb < 20  # 20MB未満ならinline_data方式（fps指定可能）

    try:
        # 1. 音声解析（ジェットカット検出）
        audio_issues = detect_jetcut_issues(tmp_path)
        audio_issues_text = "\n".join(audio_issues) if audio_issues else "無音区間は検出されませんでした。"

        # 2. 動画の準備（inline_data方式 or File API方式）
        if not use_inline:
            # 20MB以上の場合はFile APIでアップロード（fps指定不可）
            gemini_file = client.files.upload(file=tmp_path)

            while gemini_file.state.name == "PROCESSING":
                time.sleep(2)
                gemini_file = client.files.get(name=gemini_file.name)

            if gemini_file.state.name == "FAILED":
                raise HTTPException(status_code=500, detail="Gemini video processing failed.")

        # 3. プロンプト構築
        default_prompt_ja = """外注先の動画クリエイターが作成したショート動画（CapCutの編集画面録画）を添削し、フィードバック文を作成してください。

【重要な前提】
・この動画はCapCutの編集画面をスマホの画面録画機能で録画したものです。
・【超重要】あなたは「視覚的なデザインルールが守られているか」だけをチェックする検査官です。AIとしての「内容をもっとこうすれば良くなる」という提案（例：言葉選びの変更、内容の深掘りなど）は絶対にしないでください。すでに金色のテロップになっているものに対して「もっとワクワクする数字を〜」などの指摘を行うのは誤りです。
・口調は「やさしい中学校の女性教師」のようなやわらかく丁寧な敬語で書いてください。ただし「先生」を自称したり、先生として振る舞う表現は絶対に使わないでください。
・褒めるところはしっかり褒めつつ、指摘すべき点は具体的に伝えてください。
・課題の指摘では「具体的なタイムスタンプ（例：0:15あたり）」を文中に含めてください。

【添削基準（全11項目）】

① ジェットカット
音声の無音区間がないか。間が空いてしまっている箇所はカットして隙間を詰める。ただし重ねすぎて音声同士が被らないように。

② 音声
雑音やこもりがないか。棒読みにならず抑揚がついているか。聴こえやすい音量か。

③ NGワード
以下のNGワードが「画面上のテロップ」に含まれていないか確認してください。
テロップに使う場合は「半角スペース」を入れてAIの検知を回避する必要があります。
【スペースの入れ方のルール】
・2文字のNGワード → 間にスペース（例：副業→「副 業」）
・3文字以上のNGワード → 最小限の箇所に1つだけスペースを入れる（例：収益化→「収 益化」）
ユーザー定義のNGワードリスト: {ng_words_list}

④ エフェクト
・1単語だけでなく「1行全体」にエフェクトがかかっているか。
・ポジティブな言葉にはポジティブなエフェクト、ネガティブな言葉にはネガティブなエフェクト、金額には金・黄色のエフェクトなど、言葉の意味に沿った使い分けができているか。
・全てのテキストにエフェクトをかけるのではなく、大事な部分や伝えたい部分だけにつける。強弱をつける。

⑤ テロップ背景
・テロップ（字幕）の背景に敷かれている「帯（背景バー）」の四隅の形状を1つずつ確認してください。判定対象は帯の四隅であり、文字そのものの形ではありません。
・【判定基準】基準は「直角（角丸半径ゼロの長方形）」です。四隅すべてがほぼ直角（ピシッと尖った90度）に見えるなら正常で、指摘は不要です。
・【NGの定義】四隅のいずれかに、はっきりと弧を描く丸み（角丸長方形＝角がカーブして削れている状態）が見られる場合のみ「角が丸い」と指摘してください。角丸の半径が帯の高さのおおよそ1割を超えてカーブが明確に視認できる場合がこれに該当します。
・【誤判定の防止】圧縮ノイズ・低解像度・アンチエイリアス（境界のわずかなぼやけ）で角がわずかに滑らかに見えることがありますが、これは「角丸」ではありません。明確なカーブが確認できない限り直角とみなし、指摘しないでください。判断に迷う中間的なケースは「直角（正常）」として扱ってください。
・画面枠ギリギリにはみ出していないか。テキスト、挿入画像、スタンプなども枠ギリギリにならないように。

⑥ 画像の挿入
参考動画に出てくる画像を模倣して適切な画像が挿入されているか。

⑦ 文字数
・【超重要】このタスクでは「音声を完全にミュートにした状態」を想定してください。音声の書き起こし内容は完全に無視し、AIが視覚的に抽出した画像フレームに「くっきりと映っているテロップ」の文字だけをカウント対象としてください。
・画面にその瞬間に視覚的に表示されている「1行の文字数」が5〜8文字程度かどうかを判定してください。
・テロップが切り替わったら「全く別のテロップ」です。前後のテロップを合算して文字数をカウントすることは絶対にやめてください。
・文字数に問題がない場合は、この項目については何も指摘しないでください。

⑧ 数字ベースの強調
・訴求部分で数字テキストのみを大きくして強調できているか。他のテキストと同じ大きさはNG。
・【超重要】ここでは「文字の大きさ」などの視覚的な装飾だけを確認してください。テキストの内容や意味に対するアドバイスは一切不要です。

⑨ 最後の訴求
以下のリストのいずれかのパターンの構成になっているか確認してください。矢印や線引きスタンプでリンク位置を明確に示しているかどうかも確認してください。
【許容される訴求文リスト】
{call_to_action_list}

⑩ その他
背景素材の切り替えは2秒以内か。素材やテキストにアニメーションをつけているか。

⑪ 誤字脱字
テロップに誤字脱字がないか、文脈も考慮して確認してください（例：ユニクロ → ニクロ、他社 → 他者 などの誤変換や入力漏れ）。

【事前の無音区間（ジェットカット）検出結果】
以下はPythonの音声波形解析エンジンによる検出結果です（録画開始・終了時の無音は除外済み）。
検出された無音区間がある場合は「事実」として、必ずフィードバック文の中でタイムスタンプ付きで指摘してください。
{audio_issues_text}

【出力形式と構成】
以下の構成に沿って、パッと見て分かりやすい構造で出力してください。
マークダウンの記号（# や ** など）は使わず、以下の記号（【】や ■、・）をそのまま使ってプレーンテキストで出力してください。

【総評】
（動画全体に対するポジティブな感想や、大まかな評価を数行で）

【修正をお願いしたい項目】
※修正点がない項目は出力しないでください。指摘があるものだけを「■ 項目名」の見出しをつけて箇条書きで記載してください。

■ （指摘項目の名前、例：ジェットカットについて）
・0:15あたり 〜 （具体的な修正内容）

■ （指摘項目の名前、例：文字数について）
・0:30あたり 〜 （具体的な修正内容）

【最後に】
（次回の制作に向けた前向きな締めの言葉）

※そのまま外注先にコピペしてLINE等で送れる、完成された文章にしてください。
"""
        
        base_prompt = prompt_ja if prompt_ja else default_prompt_ja

        call_to_action_text = fetch_call_to_action_list(spreadsheet_url)

        # 4. プロンプトの英語への翻訳 (実際の指示出しは英語で行う)
        # 【重要】NGワードや訴求文などの日本語データは「翻訳前」に埋め込むと英訳されて壊れる
        # （例：「副業」→"side job"）。画面テロップとの逐語照合が必要なため、ここでは
        # プレースホルダ（{ng_words_list} 等）を残したままテンプレートだけを英訳し、
        # 実データは「翻訳後」に差し込む。
        translation_instruction = (
            "Translate the following video review instruction prompt from Japanese to English. "
            "Ensure that all nuances, formatting constraints, and strict instructions are perfectly preserved. "
            "CRITICAL - PLACEHOLDER PRESERVATION: The text contains literal placeholder tokens written "
            "exactly as {ng_words_list}, {audio_issues_text}, and {call_to_action_list}. "
            "You MUST output these three tokens verbatim and unchanged (same ASCII characters, same curly "
            "braces). Do NOT translate, rename, reformat, or remove them, and do NOT add or remove the braces. "
            "They are substituted programmatically AFTER translation. "
            "Any Japanese text that will later appear inside these placeholders (e.g. on-screen telop NG words "
            "and call-to-action phrases) must be matched LITERALLY as Japanese; do not expect them in English. "
            "CRITICAL INSTRUCTIONS TO ADD TO THE TRANSLATED PROMPT: "
            "1. NEVER group or summarize errors (e.g., do not say 'Errors are at 0:00, 0:06, 0:37...'). "
            "2. You MUST list EVERY SINGLE occurrence of an issue individually with its exact timestamp and a detailed explanation of what is wrong and how to fix it. "
            "3. The final output MUST be entirely in Japanese."
        )

        # 1) テンプレートのみ英訳（プレースホルダは保持したまま）
        translation_response = client.models.generate_content(
            model='gemini-3.5-flash',
            contents=[translation_instruction + "\n\n---\n\n" + base_prompt]
        )
        prompt_en = translation_response.text.strip()

        # 2) 翻訳「後」に実データを差し込む（NGワード・訴求文・無音区間を日本語のまま保持）
        required_tokens = ["{ng_words_list}", "{audio_issues_text}", "{call_to_action_list}"]
        if not all(tok in prompt_en for tok in required_tokens):
            # 翻訳器がプレースホルダを壊した場合は日本語テンプレートにフォールバック
            print("[translation] Placeholder token missing after translation; falling back to JA template.")
            prompt_en = base_prompt
        prompt_en = prompt_en.replace("{ng_words_list}", str(ng_words_list))
        prompt_en = prompt_en.replace("{audio_issues_text}", audio_issues_text)
        prompt_en = prompt_en.replace("{call_to_action_list}", call_to_action_text)

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

        if use_inline:
            # 20MB未満: inline_dataでfps=4を指定（テロップ切り替わりを250msごとに捕捉）
            response = client.models.generate_content(
                model='gemini-3.5-flash',
                contents=types.Content(
                    parts=[
                        types.Part(
                            inline_data=types.Blob(
                                data=content,
                                mime_type='video/mp4'),
                            video_metadata=types.VideoMetadata(fps=4)
                        ),
                        types.Part(text=prompt_en)
                    ]
                ),
                config=gen_config
            )
        else:
            response = client.models.generate_content(
                model='gemini-3.5-flash',
                contents=[gemini_file, prompt_en],
                config=gen_config
            )

        feedback_text = response.text.strip()

        return {"feedback": feedback_text}

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
