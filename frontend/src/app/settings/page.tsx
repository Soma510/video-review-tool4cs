"use client";

import { useState, useEffect } from "react";
import { KeyRound, ShieldAlert, Save, Trash2, Plus, CheckCircle2 } from "lucide-react";

export default function SettingsPage() {
  const [apiKey, setApiKey] = useState("");
  const [ngWords, setNgWords] = useState<string[]>([]);
  const [newWord, setNewWord] = useState("");
  const [isSaved, setIsSaved] = useState(false);

  useEffect(() => {
    const savedApiKey = localStorage.getItem("gemini_api_key");
    const savedNgWords = localStorage.getItem("ng_words");
    
    if (savedApiKey) setApiKey(savedApiKey);
    if (savedNgWords) {
      try {
        setNgWords(JSON.parse(savedNgWords));
      } catch (e) {
        console.error("Failed to parse NG words");
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
  }, []);

  const handleSaveApiKey = () => {
    localStorage.setItem("gemini_api_key", apiKey);
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
