"use client";

import { useState, useEffect, useRef } from "react";
import { Upload, CheckCircle2, Loader2, Copy, AlertTriangle, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { getApiUrl } from "@/lib/api";
import clsx from "clsx";

/** 1本あたりの消費トークン実測値（コスト試算用） */
interface UsageInfo {
  total_tokens: number;
  video_size_mb: number;
  mode: string;
  fps: number;
  translation: { total: number };
  analysis: {
    total: number;
    prompt: number;
    output: number;
    thoughts: number;
    by_modality: Record<string, number>;
  };
}

/** 訴求文リスト（スプレッドシート）の読み取り結果 */
interface CallToActionInfo {
  ok: boolean;
  count: number;
  reason: string;
}

interface ReviewItem {
  id: string;
  fileName: string;
  status: "uploading" | "done" | "error";
  feedback: string;
  errorMessage: string | null;
  timestamp: string;
  usage?: UsageInfo;
  callToAction?: CallToActionInfo;
}

// チェック結果は完了時点で自動保存され、この1つのキーだけで管理する。
// 以前は「実行中(active_reviews)」と「履歴(review_history)」の2つに分かれており、
// 手動で「履歴に保存」「復元」を行き来する必要があったが、その概念は廃止した。
const REVIEWS_KEY = "reviews";
const LEGACY_ACTIVE_KEY = "active_reviews";
const LEGACY_HISTORY_KEY = "review_history";
const MAX_REVIEWS = 50;

const INTERRUPTED_MESSAGE =
  "【エラー】画面が切り替わったため通信が中断されました。再度アップロードしてください。";

/** 実行中のまま復元された項目は通信が切れているのでエラー扱いにする。あわせてidの重複を除く。 */
function normalize(items: ReviewItem[]): ReviewItem[] {
  const seen = new Set<string>();
  const result: ReviewItem[] = [];
  for (const item of items) {
    if (!item || typeof item.id !== "string" || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(
      item.status === "uploading"
        ? { ...item, status: "error" as const, errorMessage: INTERRUPTED_MESSAGE }
        : item
    );
  }
  return result;
}

function loadReviews(): ReviewItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(REVIEWS_KEY);
    if (raw) return normalize(JSON.parse(raw));

    // 旧バージョンの2キーからの移行（実行中→履歴の順に並べ直して1本化する）
    const legacyActive: ReviewItem[] = JSON.parse(localStorage.getItem(LEGACY_ACTIVE_KEY) || "[]");
    const legacyHistory: ReviewItem[] = JSON.parse(localStorage.getItem(LEGACY_HISTORY_KEY) || "[]");
    const merged = normalize([...legacyActive, ...legacyHistory]).slice(0, MAX_REVIEWS);
    if (merged.length > 0) {
      // 新キーへ確定保存してから旧キーを消す（移行途中で失われないように）
      localStorage.setItem(REVIEWS_KEY, JSON.stringify(merged));
      localStorage.removeItem(LEGACY_ACTIVE_KEY);
      localStorage.removeItem(LEGACY_HISTORY_KEY);
    }
    return merged;
  } catch (e) {
    console.error("Failed to load reviews", e);
    return [];
  }
}

export default function DashboardPage() {
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // 折りたたみの明示的な切り替え。未指定の項目は「最新の1件だけ開く」を既定とする。
  const [expandedOverride, setExpandedOverride] = useState<Record<string, boolean>>({});
  // localStorageからの復元が終わるまで保存側のeffectを走らせないためのフラグ。
  // これがないと、復元前の空配列がlocalStorageを上書きして結果が消える。
  const [hydrated, setHydrated] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // localStorageはサーバー側に存在しないため、レンダリング中に読むとSSRの出力と
    // 食い違ってhydrationエラーになる。マウント後のeffectで読み込むのが唯一の手段。
    try {
      setReviews(loadReviews());
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    // チェック結果は変更のたびに自動保存する（復元完了後のみ）。
    // 完了時点で保存されるため、利用者が保存操作を行う必要はない。
    if (!hydrated) return;
    try {
      localStorage.setItem(REVIEWS_KEY, JSON.stringify(reviews));
    } catch (e) {
      console.error("Failed to save reviews", e);
    }
  }, [reviews, hydrated]);

  const addReview = (item: ReviewItem) => {
    setReviews(prev => [item, ...prev].slice(0, MAX_REVIEWS));
  };

  const patchReview = (id: string, patch: Partial<ReviewItem>) => {
    setReviews(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
  };

  const startReview = async (file: File) => {
    const apiKey = localStorage.getItem("gemini_api_key");
    if (!apiKey) {
      addReview({
        id: crypto.randomUUID(),
        fileName: file.name,
        status: "error",
        feedback: "",
        errorMessage: "システム設定からGemini APIキーを登録してください。",
        timestamp: new Date().toLocaleString("ja-JP"),
      });
      return;
    }

    const ngWords = localStorage.getItem("ng_words") || "[]";
    const promptJa = localStorage.getItem("prompt_ja") || "";
    const spreadsheetUrl = localStorage.getItem("spreadsheet_url") || "";
    const fps = localStorage.getItem("video_fps") || "";

    const newItem: ReviewItem = {
      id: crypto.randomUUID(),
      fileName: file.name,
      status: "uploading",
      feedback: "",
      errorMessage: null,
      timestamp: new Date().toLocaleString("ja-JP"),
    };

    addReview(newItem);

    try {
      const formData = new FormData();
      formData.append("video", file);
      formData.append("api_key", apiKey);
      formData.append("ng_words", ngWords);
      if (promptJa) {
        formData.append("prompt_ja", promptJa);
      }
      if (spreadsheetUrl) {
        formData.append("spreadsheet_url", spreadsheetUrl);
      }
      if (fps) {
        formData.append("fps", fps);
      }

      const response = await fetch(`${getApiUrl()}/analyze`, {
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

      // 完了した時点で自動保存される（保存用effectが走る）
      patchReview(newItem.id, {
        status: "done",
        feedback: data.feedback,
        usage: data.usage,
        callToAction: data.call_to_action,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const errMsg =
        message.includes("Failed to fetch") || message.includes("NetworkError")
          ? "【通信エラー】\nバックエンドサーバーに接続できませんでした。サーバーが起動しているか確認してください。"
          : `エラーが発生しました。\n\n詳細:\n${message}`;
      patchReview(newItem.id, { status: "error", errorMessage: errMsg });
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      Array.from(e.target.files).forEach(file => startReview(file));
      e.target.value = "";
    }
  };

  const copyToClipboard = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const removeReview = (item: ReviewItem) => {
    if (!confirm(`「${item.fileName}」のチェック結果を削除しますか？\nこの操作は取り消せません。`)) return;
    setReviews(prev => prev.filter(r => r.id !== item.id));
  };

  const toggleExpanded = (id: string, current: boolean) => {
    setExpandedOverride(prev => ({ ...prev, [id]: !current }));
  };

  return (
    <div className="p-4 sm:p-8 max-w-[1000px] mx-auto w-full">
      <div className="mb-6 flex items-end justify-between border-b border-[#E5E5E5] pb-4">
        <div>
          <h1 className="text-xl font-bold text-[#333333] mb-1">動画チェック</h1>
          <p className="text-[#666666] text-xs">自分が編集したCapCutの画面録画をAIでチェックします。結果は自動で保存されます。</p>
        </div>
      </div>

      <div className="space-y-6">
        {/* Upload Section */}
        <div className="bg-white rounded border border-[#E5E5E5] p-4 sm:p-6 shadow-sm">
          <h2 className="text-sm font-bold text-[#333333] border-l-4 border-[#2C4A73] pl-2 mb-4">動画のアップロード</h2>
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

        {/* Reviews（完了時点で自動保存。手動の保存・復元操作は不要） */}
        {reviews.map((item, index) => {
          // 既定では最新の1件だけ開いた状態にし、それ以外は折りたたむ
          const isExpanded = expandedOverride[item.id] ?? index === 0;
          const collapsible = item.status === "done";

          return (
            <div key={item.id} className="bg-white rounded border border-[#E5E5E5] shadow-sm overflow-hidden">
              {/* Header */}
              <div
                className={clsx(
                  "px-4 sm:px-6 py-3 border-b border-[#E5E5E5] bg-[#FAF9F6] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-0",
                  collapsible && "cursor-pointer hover:bg-[#F5F4F0] transition-colors"
                )}
                onClick={collapsible ? () => toggleExpanded(item.id, isExpanded) : undefined}
              >
                <div className="flex items-center space-x-3 w-full sm:w-auto">
                  {collapsible &&
                    (isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-[#999999] shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-[#999999] shrink-0" />
                    ))}
                  {item.status === "uploading" && <Loader2 className="w-4 h-4 text-[#2C4A73] animate-spin" />}
                  {item.status === "done" && <CheckCircle2 className="w-4 h-4 text-[#5CB85C]" />}
                  {item.status === "error" && <AlertTriangle className="w-4 h-4 text-[#D9534F]" />}
                  <div>
                    <span className="text-sm font-bold text-[#333333]">{item.fileName}</span>
                    <span className="text-xs text-[#999999] ml-3">{item.timestamp}</span>
                  </div>
                </div>
                <div className="flex items-center space-x-2" onClick={(e) => e.stopPropagation()}>
                  {item.status === "done" && (
                    <button
                      onClick={() => copyToClipboard(item.id, item.feedback)}
                      className="flex items-center text-xs bg-white border border-[#CCCCCC] hover:bg-[#FAF9F6] text-[#333333] px-3 py-1.5 rounded shadow-sm font-medium transition-colors"
                    >
                      {copiedId === item.id ? <CheckCircle2 className="w-3.5 h-3.5 mr-1.5 text-[#5CB85C]" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
                      {copiedId === item.id ? "コピーしました" : "コピー"}
                    </button>
                  )}
                  {item.status !== "uploading" && (
                    <button
                      onClick={() => removeReview(item)}
                      className="text-[#CCCCCC] hover:text-[#D9534F] transition-colors p-1"
                      title="削除"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Body */}
              {(item.status !== "done" || isExpanded) && (
                <div className="p-4 sm:p-6">
                  {item.status === "uploading" && (
                    <div className="flex items-center justify-center py-8 text-[#666666] text-sm">
                      <Loader2 className="w-5 h-5 mr-3 animate-spin text-[#2C4A73]" />
                      AIチェックを実行中です。しばらくお待ちください...
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
                    <>
                      {item.callToAction && !item.callToAction.ok && (
                        <div className="mb-3 bg-[#FFF8E1] border-l-4 border-[#E0A800] p-3 rounded text-xs">
                          <div className="font-bold text-[#333333] mb-1 flex items-center">
                            <AlertTriangle className="w-3.5 h-3.5 mr-1.5 text-[#E0A800]" />
                            訴求文リストを読み取れませんでした
                          </div>
                          <p className="text-[#4A4A4A]">{item.callToAction.reason}</p>
                          <p className="text-[#856404] mt-1">
                            「最後の訴求」の指摘は既定の1件だけで判定しているため、本来は許容される訴求文まで指摘されている可能性があります。システム設定でURLを確認してください。
                          </p>
                        </div>
                      )}
                      <textarea
                        value={item.feedback}
                        onChange={(e) => patchReview(item.id, { feedback: e.target.value })}
                        className="w-full bg-[#FAF9F6] rounded border border-[#E5E5E5] p-5 text-[#333333] text-sm leading-relaxed resize-y min-h-[200px] focus:outline-none focus:border-[#2C4A73]"
                        rows={Math.max(10, item.feedback.split("\n").length + 2)}
                      />
                      {item.usage && (
                        <div className="mt-3 text-xs text-[#999999] font-mono border-t border-[#E5E5E5] pt-2 leading-relaxed">
                          消費トークン <span className="text-[#666666] font-bold">{item.usage.total_tokens.toLocaleString()}</span>
                          {"　"}（動画解析 {item.usage.analysis.total.toLocaleString()} ／ プロンプト英訳 {item.usage.translation.total.toLocaleString()}）
                          <br />
                          内訳: 入力 {item.usage.analysis.prompt.toLocaleString()}
                          {Object.entries(item.usage.analysis.by_modality).length > 0 && (
                            <> [{Object.entries(item.usage.analysis.by_modality).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(" / ")}]</>
                          )}
                          {" ／ 思考 "}{item.usage.analysis.thoughts.toLocaleString()}
                          {" ／ 出力 "}{item.usage.analysis.output.toLocaleString()}
                          {"　"}{item.usage.video_size_mb}MB・{item.usage.mode}
                          {item.usage.fps ? `・${item.usage.fps}fps` : ""}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
