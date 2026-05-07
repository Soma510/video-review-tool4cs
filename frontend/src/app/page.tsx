"use client";

import { useState, useEffect, useRef } from "react";
import { Upload, FileVideo, Play, CheckCircle2, Loader2, Copy, AlertTriangle, Trash2, Clock, ChevronDown, ChevronUp } from "lucide-react";
import clsx from "clsx";

interface ReviewItem {
  id: string;
  fileName: string;
  status: "uploading" | "done" | "error";
  feedback: string;
  errorMessage: string | null;
  timestamp: string;
}

const HISTORY_KEY = "review_history";

function loadHistory(): ReviewItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory(items: ReviewItem[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
}

export default function DashboardPage() {
  const [activeReviews, setActiveReviews] = useState<ReviewItem[]>([]);
  const [history, setHistory] = useState<ReviewItem[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  const startReview = async (file: File) => {
    const apiKey = localStorage.getItem("gemini_api_key");
    if (!apiKey) {
      const errorItem: ReviewItem = {
        id: crypto.randomUUID(),
        fileName: file.name,
        status: "error",
        feedback: "",
        errorMessage: "システム設定からGemini APIキーを登録してください。",
        timestamp: new Date().toLocaleString("ja-JP"),
      };
      setActiveReviews(prev => [errorItem, ...prev]);
      return;
    }

    const ngWords = localStorage.getItem("ng_words") || "[]";

    const newItem: ReviewItem = {
      id: crypto.randomUUID(),
      fileName: file.name,
      status: "uploading",
      feedback: "",
      errorMessage: null,
      timestamp: new Date().toLocaleString("ja-JP"),
    };

    setActiveReviews(prev => [newItem, ...prev]);

    try {
      const formData = new FormData();
      formData.append("video", file);
      formData.append("api_key", apiKey);
      formData.append("ng_words", ngWords);

      const response = await fetch("http://localhost:8000/analyze", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errText = await response.text();
        let errMsg = errText;
        try {
          const parsed = JSON.parse(errText);
          if (parsed.detail) errMsg = parsed.detail;
        } catch {}
        throw new Error(errMsg);
      }

      const data = await response.json();

      setActiveReviews(prev =>
        prev.map(r =>
          r.id === newItem.id ? { ...r, status: "done" as const, feedback: data.feedback } : r
        )
      );
    } catch (error: any) {
      let errMsg: string;
      if (error.message.includes("Failed to fetch") || error.message.includes("NetworkError")) {
        errMsg = "【通信エラー】\nバックエンドサーバーに接続できませんでした。サーバーが起動しているか確認してください。";
      } else {
        errMsg = `エラーが発生しました。\n\n詳細:\n${error.message}`;
      }
      setActiveReviews(prev =>
        prev.map(r =>
          r.id === newItem.id ? { ...r, status: "error" as const, errorMessage: errMsg } : r
        )
      );
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      Array.from(e.target.files).forEach(file => startReview(file));
      e.target.value = "";
    }
  };

  const updateFeedback = (id: string, newText: string) => {
    setActiveReviews(prev =>
      prev.map(r => (r.id === id ? { ...r, feedback: newText } : r))
    );
  };

  const copyToClipboard = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const saveToHistory = (item: ReviewItem) => {
    const updated = [item, ...history.filter(h => h.id !== item.id)].slice(0, 50);
    setHistory(updated);
    saveHistory(updated);
    setActiveReviews(prev => prev.filter(r => r.id !== item.id));
  };

  const removeFromActive = (id: string) => {
    setActiveReviews(prev => prev.filter(r => r.id !== id));
  };

  const restoreFromHistory = (item: ReviewItem) => {
    setActiveReviews(prev => [item, ...prev]);
    const updated = history.filter(h => h.id !== item.id);
    setHistory(updated);
    saveHistory(updated);
  };

  const removeFromHistory = (id: string) => {
    const updated = history.filter(h => h.id !== id);
    setHistory(updated);
    saveHistory(updated);
  };

  return (
    <div className="p-8 max-w-[1000px] mx-auto w-full">
      <div className="mb-6 flex items-end justify-between border-b border-[#E5E5E5] pb-4">
        <div>
          <h1 className="text-xl font-bold text-[#333333] mb-1">動画添削ダッシュボード</h1>
          <p className="text-[#666666] text-xs">外注先から提出されたCapCut編集動画をAIで自動解析します。</p>
        </div>
      </div>

      <div className="space-y-6">
        {/* Upload Section */}
        <div className="bg-white rounded border border-[#E5E5E5] p-6 shadow-sm">
          <h2 className="text-sm font-bold text-[#333333] border-l-4 border-[#2C4A73] pl-2 mb-4">対象動画のアップロード</h2>
          <div className="flex flex-col sm:flex-row gap-4">
            <label className="cursor-pointer flex flex-col items-center justify-center flex-1 h-32 border-2 border-dashed border-[#DCD9D0] bg-[#FAF9F6] rounded hover:bg-[#F5F4F0] transition-colors">
              <Upload className="w-6 h-6 text-[#2C4A73] mb-2" />
              <span className="text-sm font-bold text-[#4A4A4A]">動画を選択（複数可）</span>
              <span className="text-xs text-[#999999] mt-1">MP4, MOV</span>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/mp4,video/quicktime"
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />
            </label>
          </div>
        </div>

        {/* Active Reviews */}
        {activeReviews.map(item => (
          <div key={item.id} className="bg-white rounded border border-[#E5E5E5] shadow-sm overflow-hidden">
            {/* Header */}
            <div className="px-6 py-3 border-b border-[#E5E5E5] bg-[#FAF9F6] flex items-center justify-between">
              <div className="flex items-center space-x-3">
                {item.status === "uploading" && <Loader2 className="w-4 h-4 text-[#2C4A73] animate-spin" />}
                {item.status === "done" && <CheckCircle2 className="w-4 h-4 text-[#5CB85C]" />}
                {item.status === "error" && <AlertTriangle className="w-4 h-4 text-[#D9534F]" />}
                <div>
                  <span className="text-sm font-bold text-[#333333]">{item.fileName}</span>
                  <span className="text-xs text-[#999999] ml-3">{item.timestamp}</span>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                {item.status === "done" && (
                  <>
                    <button
                      onClick={() => copyToClipboard(item.id, item.feedback)}
                      className="flex items-center text-xs bg-white border border-[#CCCCCC] hover:bg-[#FAF9F6] text-[#333333] px-3 py-1.5 rounded shadow-sm font-medium transition-colors"
                    >
                      {copiedId === item.id ? <CheckCircle2 className="w-3.5 h-3.5 mr-1.5 text-[#5CB85C]" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
                      {copiedId === item.id ? "コピーしました" : "コピー"}
                    </button>
                    <button
                      onClick={() => saveToHistory(item)}
                      className="flex items-center text-xs bg-white border border-[#CCCCCC] hover:bg-[#FAF9F6] text-[#333333] px-3 py-1.5 rounded shadow-sm font-medium transition-colors"
                    >
                      <Clock className="w-3.5 h-3.5 mr-1.5" />
                      履歴に保存
                    </button>
                  </>
                )}
                {item.status !== "uploading" && (
                  <button
                    onClick={() => removeFromActive(item.id)}
                    className="text-[#CCCCCC] hover:text-[#D9534F] transition-colors p-1"
                    title="閉じる"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Body */}
            <div className="p-6">
              {item.status === "uploading" && (
                <div className="flex items-center justify-center py-8 text-[#666666] text-sm">
                  <Loader2 className="w-5 h-5 mr-3 animate-spin text-[#2C4A73]" />
                  AI添削を実行中です。しばらくお待ちください...
                </div>
              )}
              {item.status === "error" && item.errorMessage && (
                <div className="bg-[#FDF2F2] border-l-4 border-[#D9534F] p-4 rounded">
                  <div className="text-sm text-[#333333] whitespace-pre-wrap font-mono bg-white p-3 rounded border border-[#F5C6CB] select-all">
                    {item.errorMessage}
                  </div>
                </div>
              )}
              {item.status === "done" && (
                <textarea
                  value={item.feedback}
                  onChange={(e) => updateFeedback(item.id, e.target.value)}
                  className="w-full bg-[#FAF9F6] rounded border border-[#E5E5E5] p-5 text-[#333333] text-sm leading-relaxed resize-y min-h-[200px] focus:outline-none focus:border-[#2C4A73]"
                  rows={Math.max(10, item.feedback.split("\n").length + 2)}
                />
              )}
            </div>
          </div>
        ))}

        {/* History Section */}
        {history.length > 0 && (
          <div className="bg-white rounded border border-[#E5E5E5] shadow-sm overflow-hidden">
            <button
              onClick={() => setHistoryOpen(!historyOpen)}
              className="w-full px-6 py-4 bg-[#FAF9F6] flex items-center justify-between hover:bg-[#F5F4F0] transition-colors"
            >
              <h2 className="text-sm font-bold text-[#333333] flex items-center">
                <Clock className="w-4 h-4 mr-2 text-[#2C4A73]" />
                添削履歴（{history.length}件）
              </h2>
              {historyOpen ? <ChevronUp className="w-4 h-4 text-[#999999]" /> : <ChevronDown className="w-4 h-4 text-[#999999]" />}
            </button>

            {historyOpen && (
              <div className="divide-y divide-[#E5E5E5]">
                {history.map(item => (
                  <div key={item.id} className="px-6 py-3 flex items-center justify-between hover:bg-[#FAF9F6]">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-[#333333] truncate block">{item.fileName}</span>
                      <span className="text-xs text-[#999999]">{item.timestamp}</span>
                    </div>
                    <div className="flex items-center space-x-2 ml-4">
                      <button
                        onClick={() => copyToClipboard(item.id, item.feedback)}
                        className="text-xs bg-white border border-[#CCCCCC] hover:bg-[#FAF9F6] text-[#333333] px-2 py-1 rounded font-medium transition-colors"
                      >
                        {copiedId === item.id ? "コピー済" : "コピー"}
                      </button>
                      <button
                        onClick={() => restoreFromHistory(item)}
                        className="text-xs bg-white border border-[#CCCCCC] hover:bg-[#FAF9F6] text-[#333333] px-2 py-1 rounded font-medium transition-colors"
                      >
                        復元
                      </button>
                      <button
                        onClick={() => removeFromHistory(item.id)}
                        className="text-[#CCCCCC] hover:text-[#D9534F] transition-colors p-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
