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
      setNgWords(["副業", "1000円", "稼ぐ", "儲け", "収益", "投資", "株", "ギャンブル"]);
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
    if (!newWord.trim() || ngWords.includes(newWord.trim())) return;
    const updatedWords = [...ngWords, newWord.trim()];
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
    <div className="p-8 max-w-[800px] mx-auto w-full">
      <div className="mb-6 border-b border-[#E5E5E5] pb-4">
        <h1 className="text-xl font-bold text-[#333333] mb-1">システム設定</h1>
        <p className="text-[#666666] text-xs">AI解析を利用するためのAPIキーや、自動チェックする禁止用語を管理します。</p>
      </div>

      <div className="space-y-6">
        {/* API Key Section */}
        <div className="bg-white rounded border border-[#E5E5E5] p-6 shadow-sm">
          <div className="flex items-center mb-4">
            <KeyRound className="w-5 h-5 text-[#2C4A73] mr-2" />
            <h2 className="text-sm font-bold text-[#333333]">Gemini API キー</h2>
          </div>
          <p className="text-xs text-[#666666] mb-4">
            動画解析を行うための認証キーです。ブラウザのローカルストレージに安全に保存されます。
          </p>
          <div className="flex space-x-3">
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
        <div className="bg-white rounded border border-[#E5E5E5] p-6 shadow-sm">
          <div className="flex items-center mb-4">
            <ShieldAlert className="w-5 h-5 text-[#D9534F] mr-2" />
            <h2 className="text-sm font-bold text-[#333333]">NGワード（禁止用語）リスト</h2>
          </div>
          <p className="text-xs text-[#666666] mb-4">
            ここで登録した単語が動画の音声やテロップに含まれている場合、自動的に課題として指摘されます。
          </p>
          
          <div className="flex space-x-3 mb-6">
            <input
              type="text"
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addNgWord()}
              placeholder="追加するNGワードを入力"
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
        <div className="fixed bottom-6 right-6 bg-white border border-[#5CB85C] text-[#333333] px-4 py-3 rounded shadow-lg flex items-center animate-fade-in-up">
          <CheckCircle2 className="w-4 h-4 text-[#5CB85C] mr-2" />
          <span className="font-bold text-sm">設定を保存しました</span>
        </div>
      )}
    </div>
  );
}
