"use client";

import { useState, useEffect } from "react";
import { KeyRound, ShieldAlert, Save, Trash2, Plus, CheckCircle2, FileText, RotateCcw, Loader2, Film, Crop } from "lucide-react";
import { fetchDefaultPrompt, checkCallToActionList, type CallToActionCheck } from "@/lib/api";
import clsx from "clsx";

const DEFAULT_FPS = "4";

/** サンプリングFPSの選択肢。削減率は実測値（動画1本あたり約54,000トークン）から算出。 */
const FPS_OPTIONS = [
  { value: "4", label: "4 fps（250ms間隔）", detail: "既定値。テロップ1枚あたり約4フレームを取得します。最も取りこぼしが少ない設定です。" },
  { value: "3", label: "3 fps（333ms間隔）", detail: "コスト約15%減。テロップ1枚あたり約3フレーム。精度への影響はほぼありません。" },
  { value: "2", label: "2 fps（500ms間隔）", detail: "コスト約31%減。テロップ1枚あたり約2フレーム。文字数や誤字脱字の判定精度が落ちる可能性があります。" },
  { value: "1", label: "1 fps（1000ms間隔）", detail: "コスト約46%減。Geminiの既定値ですが、表示の短いテロップを丸ごと取りこぼす恐れがあります。" },
];

/** 画角・デッドゾーンのチェック（試験運用）。実際の録画で精度を確認するまで、初期状態はOFF。 */
const LAYOUT_OPTIONS = [
  { key: "check_black_bars", label: "黒帯（縦横比のミス）をチェックする", detail: "素材がキャンバスに合っておらず、上下・左右に黒い帯が出ている箇所を指摘します。画像解析だけで判定するため、APIの利用は増えません。" },
  { key: "check_dead_zone", label: "デッドゾーンへのテロップ配置をチェックする", detail: "TikTok・InstagramのUIに隠れる位置に、テロップの面積の2割以上が入っている箇所を指摘します。テロップの位置をAIで読み取るため、1回のチェックにつきAPIの呼び出しが1回増えます（有料枠の場合は約3〜6円）。" },
  { key: "layout_debug", label: "判定根拠の画像を表示する（検証用）", detail: "検出したプレビュー枠・黒帯の境目・テロップの枠を描き込んだ画像を、結果の下に表示します。画像は保存されません。" },
];

export default function SettingsPage() {
  const [apiKey, setApiKey] = useState("");
  const [spreadsheetUrl, setSpreadsheetUrl] = useState("");
  const [ngWords, setNgWords] = useState<string[]>([]);
  const [newWord, setNewWord] = useState("");
  const [promptJa, setPromptJa] = useState("");
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [layoutChecks, setLayoutChecks] = useState<Record<string, boolean>>({});
  const [ctaCheck, setCtaCheck] = useState<CallToActionCheck | null>(null);
  const [ctaChecking, setCtaChecking] = useState(false);
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [isSaved, setIsSaved] = useState(false);

  const loadDefaultPrompt = async (): Promise<string | null> => {
    setPromptLoading(true);
    setPromptError(null);
    try {
      const prompt = await fetchDefaultPrompt();
      setPromptJa(prompt);
      return prompt;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setPromptError(
        `デフォルトプロンプトを読み込めませんでした。バックエンドサーバーが起動しているか確認してください。\n詳細: ${detail}`
      );
      return null;
    } finally {
      setPromptLoading(false);
    }
  };

  useEffect(() => {
    // localStorageはサーバー側に存在しないため、レンダリング中に読むとSSRの出力と
    // 食い違ってhydrationエラーになる。マウント後のeffectで読み込むのが唯一の手段なので
    // set-state-in-effect ルールはこのeffectに限り無効化する。
    /* eslint-disable react-hooks/set-state-in-effect */
    const savedApiKey = localStorage.getItem("gemini_api_key");
    const savedSpreadsheetUrl = localStorage.getItem("spreadsheet_url");
    const savedNgWords = localStorage.getItem("ng_words");
    const savedPromptJa = localStorage.getItem("prompt_ja");
    const savedFps = localStorage.getItem("video_fps");

    if (savedFps && FPS_OPTIONS.some(o => o.value === savedFps)) setFps(savedFps);
    setLayoutChecks(Object.fromEntries(LAYOUT_OPTIONS.map(o => [o.key, localStorage.getItem(o.key) === "1"])));
    if (savedApiKey) setApiKey(savedApiKey);
    if (savedSpreadsheetUrl) setSpreadsheetUrl(savedSpreadsheetUrl);
    if (savedPromptJa) {
      setPromptJa(savedPromptJa);
    } else {
      // 未保存の場合はバックエンドのデフォルトプロンプトを取得して表示する
      void loadDefaultPrompt();
    }

    if (savedNgWords) {
      try {
        setNgWords(JSON.parse(savedNgWords));
      } catch (e) {
        console.error("Failed to parse NG words", e);
      }
    } else {
      setNgWords([
        "副業", "1000円", "稼ぐ", "儲け", "収益", "投資", "株", "ギャンブル", "円", "利益", 
        "報酬", "金利", "収支", "支払い", "支払う", "給料", "給与", "賃金", "資産", "月収", 
        "売却", "不労所得", "円高", "円安", "ドル", "$", "¥", "金", "年金", "借金", 
        "徴収", "料金", "料", "値上げ", "物価", "時給", "安値", "高値", "価値", "価格", 
        "減税", "割引", "定面", "高騰", "定価", "支給", "高価格", "低価格", "原価", "高い", 
        "低い", "年収", "月給", "日給", "ギャラ", "現金", "小遣い", "おこづかい", "資金", "売上", 
        "紹介", "招待", "物販", "アフィリエイト", "フォロー", "TikTok見るだけ", "運用", "PR", "コメント", "出品", 
        "商品", "ギャンブル系", "カジノ", "得", "酒", "タバコ", "子供", "ヒトラー", "パパ活", "コロナ", 
        "洗脳", "操る", "アホ", "バカ", "ボケ", "無料ギフト", "嫌い", "無理", "爆破", "盗む", 
        "外人", "キチガイ", "クソ野郎", "AI", "簡単にできる", "プロフリンク", "プロフ", "リンク", "りんく", "URL", 
        "UPL", "LINE", "ライン", "YouTube", "amazon", "楽天", "消された"
      ]);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const handleSaveApiKey = () => {
    localStorage.setItem("gemini_api_key", apiKey);
    showSavedNotification();
  };

  const handleSaveSpreadsheetUrl = () => {
    localStorage.setItem("spreadsheet_url", spreadsheetUrl);
    showSavedNotification();
    void runCtaCheck(spreadsheetUrl);
  };

  /** 保存したURLから実際に訴求文が読めるかを確認する（動画を消費せずに検証できる） */
  const runCtaCheck = async (url: string) => {
    setCtaChecking(true);
    setCtaCheck(null);
    try {
      setCtaCheck(await checkCallToActionList(url));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setCtaCheck({ ok: false, count: 0, actions: [], skipped: [], reason: `確認できませんでした。バックエンドサーバーが起動しているか確認してください。（${detail}）` });
    } finally {
      setCtaChecking(false);
    }
  };

  const handleSelectFps = (value: string) => {
    setFps(value);
    localStorage.setItem("video_fps", value);
    showSavedNotification();
  };

  const handleToggleLayoutCheck = (key: string, enabled: boolean) => {
    setLayoutChecks(prev => ({ ...prev, [key]: enabled }));
    localStorage.setItem(key, enabled ? "1" : "0");
    showSavedNotification();
  };

  const handleSavePrompt = () => {
    localStorage.setItem("prompt_ja", promptJa);
    showSavedNotification();
  };

  const handleResetPrompt = async () => {
    if (!confirm("プロンプトを初期状態に戻しますか？")) return;
    const prompt = await loadDefaultPrompt();
    if (prompt === null) return; // 取得に失敗した場合は現在の内容を壊さない
    localStorage.setItem("prompt_ja", prompt);
    showSavedNotification();
  };

  const handleSaveNgWords = (words: string[]) => {
    localStorage.setItem("ng_words", JSON.stringify(words));
    showSavedNotification();
  };

  const showSavedNotification = () => {
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 3000);
  };

  const addNgWord = () => {
    if (!newWord.trim()) return;
    
    const inputWords = newWord
      .split(/[, \n、　]+/)
      .map(w => w.trim())
      .filter(w => w !== "");
      
    const uniqueNewWords = inputWords.filter(w => !ngWords.includes(w));
    
    if (uniqueNewWords.length === 0) {
      setNewWord("");
      return;
    }
    
    const updatedWords = Array.from(new Set([...ngWords, ...uniqueNewWords]));
    setNgWords(updatedWords);
    setNewWord("");
    handleSaveNgWords(updatedWords);
  };

  const removeNgWord = (wordToRemove: string) => {
    const updatedWords = ngWords.filter(word => word !== wordToRemove);
    setNgWords(updatedWords);
    handleSaveNgWords(updatedWords);
  };

  return (
    <div className="p-4 sm:p-8 max-w-[800px] mx-auto w-full">
      <div className="mb-6 border-b border-[#E5E5E5] pb-4">
        <h1 className="text-xl font-bold text-[#333333] mb-1">システム設定</h1>
        <p className="text-[#666666] text-xs">AI解析を利用するためのAPIキーや、自動チェックする禁止用語を管理します。</p>
      </div>

      <div className="space-y-6">
        {/* API Key Section */}
        <div className="bg-white rounded border border-[#E5E5E5] p-4 sm:p-6 shadow-sm">
          <div className="flex items-center mb-4">
            <KeyRound className="w-5 h-5 text-[#2C4A73] mr-2" />
            <h2 className="text-sm font-bold text-[#333333]">Gemini API キー</h2>
          </div>
          <p className="text-xs text-[#666666] mb-4">
            動画解析を行うための認証キーです。ブラウザのローカルストレージに安全に保存されます。
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="AIzaSy..."
              className="flex-1 bg-[#FAF9F6] border border-[#E5E5E5] text-[#333333] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#2C4A73]"
            />
            <button
              onClick={handleSaveApiKey}
              className="bg-[#2C4A73] hover:bg-[#1E3A8A] text-white px-6 py-2 rounded text-sm font-bold flex items-center transition-colors shadow-sm"
            >
              <Save className="w-4 h-4 mr-2" />
              保存
            </button>
          </div>
        </div>

        {/* Spreadsheet URL Section */}
        <div className="bg-white rounded border border-[#E5E5E5] p-4 sm:p-6 shadow-sm">
          <div className="flex items-center mb-4">
            <FileText className="w-5 h-5 text-[#2C4A73] mr-2" />
            <h2 className="text-sm font-bold text-[#333333]">訴求文リスト (Spreadsheet URL)</h2>
          </div>
          <p className="text-xs text-[#666666] mb-4">
            最後の訴求文のチェックに使用するGoogleスプレッドシートのURLを入力してください。ここに載っていない訴求文が使われていた場合に指摘されます。<br />
            ※ 共有設定を「<strong className="text-[#333333]">リンクを知っている全員</strong>」が閲覧可にしてください。非公開だと読み取れません。<br />
            ※ 訴求文は縦に並べ、見出しのセルに「<strong className="text-[#333333]">訴求文</strong>」と入れてください（見出しが無い場合はB列4行目以降を読みます）。
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              value={spreadsheetUrl}
              onChange={(e) => setSpreadsheetUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              className="flex-1 bg-[#FAF9F6] border border-[#E5E5E5] text-[#333333] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#2C4A73]"
            />
            <button
              onClick={handleSaveSpreadsheetUrl}
              disabled={ctaChecking}
              className="bg-[#2C4A73] hover:bg-[#1E3A8A] text-white px-6 py-2 rounded text-sm font-bold flex items-center transition-colors shadow-sm disabled:opacity-60"
            >
              {ctaChecking ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              保存して確認
            </button>
          </div>

          {/* 読み取り結果。ここで確認できないと「動かない理由」が分からないまま使い続けることになる */}
          {ctaChecking && (
            <div className="mt-3 text-xs text-[#666666] flex items-center">
              <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
              スプレッドシートを読み取っています...
            </div>
          )}
          {!ctaChecking && ctaCheck && (
            <div
              className={clsx(
                "mt-3 p-3 rounded border-l-4 text-xs",
                ctaCheck.ok ? "bg-[#F1F8F1] border-[#5CB85C]" : "bg-[#FDF2F2] border-[#D9534F]"
              )}
            >
              {ctaCheck.ok ? (
                <>
                  <div className="flex items-center font-bold text-[#333333] mb-2">
                    <CheckCircle2 className="w-4 h-4 mr-1.5 text-[#5CB85C]" />
                    訴求文を{ctaCheck.count}件読み取りました
                  </div>
                  <ul className="space-y-0.5 text-[#4A4A4A]">
                    {ctaCheck.actions.map((action, i) => (
                      <li key={i}>・{action}</li>
                    ))}
                  </ul>
                  <p className="text-[#999999] mt-2">この一覧に無い訴求文が使われていた場合に指摘されます。過不足があればシートを修正して、もう一度確認してください。</p>
                  {ctaCheck.skipped.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-[#D7E7D7]">
                      <p className="text-[#666666] font-bold mb-1">注意書きとして除外した行（{ctaCheck.skipped.length}件）</p>
                      <ul className="space-y-0.5 text-[#999999]">
                        {ctaCheck.skipped.map((s, i) => (
                          <li key={i} className="line-clamp-2">・{s}</li>
                        ))}
                      </ul>
                      <p className="text-[#999999] mt-1">訴求文ではないと判断したため、判定には使いません。もし訴求文だった場合は、行頭の記号（⚠️や※）を外してください。</p>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-center font-bold text-[#333333] mb-1">
                    <ShieldAlert className="w-4 h-4 mr-1.5 text-[#D9534F]" />
                    訴求文リストを読み取れませんでした
                  </div>
                  <p className="text-[#4A4A4A]">{ctaCheck.reason}</p>
                  <p className="text-[#999999] mt-2">このままチェックを実行すると、既定の訴求文1件だけで判定するため、本来は許容されるはずの訴求文まで指摘されます。</p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Sampling FPS Section */}
        <div className="bg-white rounded border border-[#E5E5E5] p-4 sm:p-6 shadow-sm">
          <div className="flex items-center mb-4">
            <Film className="w-5 h-5 text-[#2C4A73] mr-2" />
            <h2 className="text-sm font-bold text-[#333333]">解析の細かさ（サンプリングFPS）</h2>
          </div>
          <p className="text-xs text-[#666666] mb-4">
            動画を1秒あたり何コマ切り出してAIに渡すかの設定です。細かくするほどテロップの切り替わりを正確に捉えられますが、その分コストが上がります。<br />
            消費トークンのうち約8割が動画のコマ分なので、<strong className="text-[#333333]">この設定がコストにほぼ直結します</strong>。
          </p>
          <div className="space-y-2">
            {FPS_OPTIONS.map(option => (
              <label
                key={option.value}
                className={clsx(
                  "flex items-start p-3 rounded border cursor-pointer transition-colors",
                  fps === option.value
                    ? "border-[#2C4A73] bg-[#F4F6F8]"
                    : "border-[#E5E5E5] bg-[#FAF9F6] hover:bg-[#F5F4F0]"
                )}
              >
                <input
                  type="radio"
                  name="fps"
                  value={option.value}
                  checked={fps === option.value}
                  onChange={() => handleSelectFps(option.value)}
                  className="mt-0.5 mr-3 accent-[#2C4A73]"
                />
                <span className="flex-1">
                  <span className="block text-sm font-bold text-[#333333]">{option.label}</span>
                  <span className="block text-xs text-[#666666] mt-0.5">{option.detail}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Layout Check Section */}
        <div className="bg-white rounded border border-[#E5E5E5] p-4 sm:p-6 shadow-sm">
          <div className="flex items-center mb-4">
            <Crop className="w-5 h-5 text-[#2C4A73] mr-2" />
            <h2 className="text-sm font-bold text-[#333333]">画角・デッドゾーンのチェック（試験運用）</h2>
          </div>
          <p className="text-xs text-[#666666] mb-4">
            画面録画の中からCapCutのプレビュー枠を見つけて、黒帯やテロップの位置を判定します。実際の動画で精度を確認するまで、初期状態はOFFにしています。<br />
            デッドゾーン（1080×1920基準）：上250px・左右120px・下480px・右下の縦長部分（下から1080px × 右端から300px）
          </p>
          <div className="space-y-2">
            {LAYOUT_OPTIONS.map(option => (
              <label
                key={option.key}
                className={clsx(
                  "flex items-start p-3 rounded border cursor-pointer transition-colors",
                  layoutChecks[option.key]
                    ? "border-[#2C4A73] bg-[#F4F6F8]"
                    : "border-[#E5E5E5] bg-[#FAF9F6] hover:bg-[#F5F4F0]"
                )}
              >
                <input
                  type="checkbox"
                  checked={!!layoutChecks[option.key]}
                  onChange={(e) => handleToggleLayoutCheck(option.key, e.target.checked)}
                  className="mt-0.5 mr-3 accent-[#2C4A73]"
                />
                <span className="flex-1">
                  <span className="block text-sm font-bold text-[#333333]">{option.label}</span>
                  <span className="block text-xs text-[#666666] mt-0.5">{option.detail}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Prompt Section */}
        <div className="bg-white rounded border border-[#E5E5E5] p-4 sm:p-6 shadow-sm">
          <div className="flex items-center mb-4">
            <FileText className="w-5 h-5 text-[#2C4A73] mr-2" />
            <h2 className="text-sm font-bold text-[#333333]">AI解析プロンプト（指示書）</h2>
          </div>
          <p className="text-xs text-[#666666] mb-4">
            AIへの指示内容を日本語で編集できます。ここに入力された内容は、分析実行時に自動的に最適な英語に翻訳されてAIに渡されます。<br/>
            ※ <code>{'{ng_words_list}'}</code>、<code>{'{audio_issues_text}'}</code>、<code>{'{call_to_action_list}'}</code>、<code>{'{layout_issues_text}'}</code> の部分は、実行時に実際の内容に自動置換されます。そのまま残してください。
          </p>
          {promptError && (
            <div className="mb-3 bg-[#FDF2F2] border-l-4 border-[#D9534F] px-3 py-2 rounded text-xs text-[#333333] whitespace-pre-wrap">
              {promptError}
            </div>
          )}
          <div className="flex flex-col gap-3">
            <textarea
              value={promptJa}
              onChange={(e) => setPromptJa(e.target.value)}
              disabled={promptLoading}
              placeholder={promptLoading ? "デフォルトプロンプトを読み込み中です..." : ""}
              className="w-full bg-[#FAF9F6] border border-[#E5E5E5] text-[#333333] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#2C4A73] font-mono min-h-[300px] resize-y disabled:opacity-60"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={handleResetPrompt}
                disabled={promptLoading}
                className="bg-white hover:bg-[#FAF9F6] text-[#666666] border border-[#CCCCCC] px-4 py-2 rounded text-sm font-bold flex items-center transition-colors shadow-sm disabled:opacity-60"
              >
                {promptLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-2" />}
                初期状態に戻す
              </button>
              <button
                onClick={handleSavePrompt}
                disabled={promptLoading || !promptJa}
                className="bg-[#2C4A73] hover:bg-[#1E3A8A] text-white px-6 py-2 rounded text-sm font-bold flex items-center transition-colors shadow-sm disabled:opacity-60"
              >
                <Save className="w-4 h-4 mr-2" />
                保存
              </button>
            </div>
          </div>
        </div>

        {/* NG Words Section */}
        <div className="bg-white rounded border border-[#E5E5E5] p-4 sm:p-6 shadow-sm">
          <div className="flex items-center mb-4">
            <ShieldAlert className="w-5 h-5 text-[#D9534F] mr-2" />
            <h2 className="text-sm font-bold text-[#333333]">NGワード（禁止用語）リスト</h2>
          </div>
          <p className="text-xs text-[#666666] mb-4">
            ここで登録した単語が動画の音声やテロップに含まれている場合、自動的に課題として指摘されます。
          </p>
          
          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            <input
              type="text"
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addNgWord()}
              placeholder="追加するNGワードを入力（スペースやカンマ区切りで複数可）"
              className="flex-1 bg-[#FAF9F6] border border-[#E5E5E5] text-[#333333] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#2C4A73]"
            />
            <button
              onClick={addNgWord}
              className="bg-white hover:bg-[#FAF9F6] text-[#333333] border border-[#CCCCCC] px-6 py-2 rounded text-sm font-bold flex items-center transition-colors shadow-sm"
            >
              <Plus className="w-4 h-4 mr-1" />
              追加
            </button>
          </div>

          <div className="bg-[#FAF9F6] rounded border border-[#E5E5E5] p-4 min-h-[100px]">
            {ngWords.length === 0 ? (
              <p className="text-[#999999] text-center py-4 text-xs">NGワードが登録されていません</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {ngWords.map((word) => (
                  <div
                    key={word}
                    className="flex items-center bg-white border border-[#E5E5E5] shadow-sm text-[#4A4A4A] px-2.5 py-1 rounded text-xs font-medium"
                  >
                    <span>{word}</span>
                    <button
                      onClick={() => removeNgWord(word)}
                      className="ml-2 text-[#CCCCCC] hover:text-[#D9534F] transition-colors"
                      title="削除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {isSaved && (
        <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 bg-white border border-[#5CB85C] text-[#333333] px-4 py-3 rounded shadow-lg flex items-center animate-fade-in-up">
          <CheckCircle2 className="w-4 h-4 text-[#5CB85C] mr-2" />
          <span className="font-bold text-sm">設定を保存しました</span>
        </div>
      )}
    </div>
  );
}
