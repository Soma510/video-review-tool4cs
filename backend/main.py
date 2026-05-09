import os
import json
import tempfile
import time
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
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def format_time(ms: int) -> str:
    seconds = int((ms / 1000) % 60)
    minutes = int((ms / (1000 * 60)) % 60)
    return f"{minutes:02d}:{seconds:02d}"


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
    ng_words: str = Form("[]")
):
    try:
        ng_words_list = json.loads(ng_words)
    except Exception:
        ng_words_list = []

    client = genai.Client(api_key=api_key)

    with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as tmp:
        content = await video.read()
        tmp.write(content)
        tmp_path = tmp.name

    gemini_file = None
    try:
        # 1. 音声解析（ジェットカット検出）
        audio_issues = detect_jetcut_issues(tmp_path)
        audio_issues_text = "\n".join(audio_issues) if audio_issues else "無音区間は検出されませんでした。"

        # 2. Geminiにアップロード
        gemini_file = client.files.upload(file=tmp_path)

        while gemini_file.state.name == "PROCESSING":
            time.sleep(2)
            gemini_file = client.files.get(name=gemini_file.name)

        if gemini_file.state.name == "FAILED":
            raise HTTPException(status_code=500, detail="Gemini video processing failed.")

        # 3. プロンプト構築
        prompt = f"""外注先の動画クリエイターが作成したショート動画（CapCutの編集画面録画）を添削し、フィードバック文を作成してください。

【重要な前提】
・この動画はCapCutの編集画面をスマホの画面録画機能で録画したものです。
・【超重要】あなたは「視覚的なデザインルールが守られているか」だけをチェックする検査官です。AIとしての「内容をもっとこうすれば良くなる」という提案（例：言葉選びの変更、内容の深掘りなど）は絶対にしないでください。すでに金色のテロップになっているものに対して「もっとワクワクする数字を〜」などの指摘を行うのは誤りです。
・口調は「やさしい中学校の女性教師」のようなやわらかく丁寧な敬語で書いてください。ただし「先生」を自称したり、先生として振る舞う表現は絶対に使わないでください。
・褒めるところはしっかり褒めつつ、指摘すべき点は具体的に伝えてください。
・課題の指摘では「具体的なタイムスタンプ（例：0:15あたり）」を文中に含めてください。

【添削基準（全10項目）】

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
・背景の帯の角が「鋭角」になっているか。明らかに丸みを帯びている場合のみ指摘すること。少しでも角張って見えるなら問題ない。
・画面枠ギリギリにはみ出していないか。テキスト、挿入画像、スタンプなども枠ギリギリにならないように。

⑥ 画像の挿入
参考動画に出てくる画像を模倣して適切な画像が挿入されているか。

⑦ 文字数
・【超重要】音声の書き起こし（喋っている内容）をベースにしないでください。動画の画面に「視覚的に表示されているテロップの文字」だけを見て判断してください。
・画面にその瞬間に表示されている1行の文字数が5〜8文字程度かどうかを判定してください。
・テロップが切り替わったら「別のテロップ」です。前後のテロップを合算して「13文字で文字数オーバーです」と判定するのは絶対にやめてください。
・文字数に問題がない場合は、この項目については何も指摘しないでください。

⑧ 数字ベースの強調
・訴求部分で数字テキストのみを大きくして強調できているか。他のテキストと同じ大きさはNG。
・【超重要】ここでは「文字の大きさ」などの視覚的な装飾だけを確認してください。テキストの内容や意味に対するアドバイスは一切不要です。

⑨ 最後の訴求
「〇〇とコメントしてプロフィールのリンクを見てね」という構成になっているか。矢印や線引きスタンプでリンク位置を明確に示しているか。

⑩ その他
背景素材の切り替えは2秒以内か。素材やテキストにアニメーションをつけているか。

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

        from google.genai import types
        response = client.models.generate_content(
            model='gemini-3-flash-preview',
            contents=[gemini_file, prompt],
            config=types.GenerateContentConfig(
                thinking_config=types.ThinkingConfig(includeThoughts=True),
                temperature=0.2  # より確実な（ブレの少ない）判定を行わせるため温度を下げる
            )
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
