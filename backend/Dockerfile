# Pythonの公式イメージを使用
FROM python:3.11-slim

# FFmpegをインストール
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 作業ディレクトリを設定
WORKDIR /app

# 依存関係ファイルをコピーしてインストール
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# コード全体をコピー
COPY . .

# サーバー起動（Renderのポートに合わせる）
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "10000"]
