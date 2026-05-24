"use client";

import { useState, useEffect } from "react";
import { KeyRound, ShieldAlert, Save, Trash2, Plus, CheckCircle2, FileText, RotateCcw } from "lucide-react";

const DEFAULT_PROMPT = `外注先の動画クリエイターが作成したショート動画（CapCutの編集画面録画）を添削し、フィードバック文を作成してください。

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
`;

export default function SettingsPage() {
  const [apiKey, setApiKey] = useState("");
  const [spreadsheetUrl, setSpreadsheetUrl] = useState("");
  const [ngWords, setNgWords] = useState<string[]>([]);
  const [newWord, setNewWord] = useState("");
  const [promptJa, setPromptJa] = useState("");
  const [isSaved, setIsSaved] = useState(false);

  useEffect(() => {
    const savedApiKey = localStorage.getItem("gemini_api_key");
    const savedSpreadsheetUrl = localStorage.getItem("spreadsheet_url");
    const savedNgWords = localStorage.getItem("ng_words");
    const savedPromptJa = localStorage.getItem("prompt_ja");
    
    if (savedApiKey) setApiKey(savedApiKey);
    if (savedSpreadsheetUrl) setSpreadsheetUrl(savedSpreadsheetUrl);
    if (savedPromptJa) {
      setPromptJa(savedPromptJa);
    } else {
      setPromptJa(DEFAULT_PROMPT);
    }
    
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

  const handleSaveSpreadsheetUrl = () => {
    localStorage.setItem("spreadsheet_url", spreadsheetUrl);
    showSavedNotification();
  };

  const handleSavePrompt = () => {
    localStorage.setItem("prompt_ja", promptJa);
    showSavedNotification();
  };

  const handleResetPrompt = () => {
    if (confirm("プロンプトを初期状態に戻しますか？")) {
      setPromptJa(DEFAULT_PROMPT);
      localStorage.setItem("prompt_ja", DEFAULT_PROMPT);
      showSavedNotification();
    }
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
            最後の訴求文のチェックに使用するGoogleスプレッドシートのURLを入力してください。（※「リンクを知っている全員」が閲覧可能になっている必要があります）
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
              className="bg-[#2C4A73] hover:bg-[#1E3A8A] text-white px-6 py-2 rounded text-sm font-bold flex items-center transition-colors shadow-sm"
            >
              <Save className="w-4 h-4 mr-2" />
              保存
            </button>
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
            ※ <code>{'{ng_words_list}'}</code> や <code>{'{audio_issues_text}'}</code> の部分は、実行時に実際の内容に自動置換されます。そのまま残してください。
          </p>
          <div className="flex flex-col gap-3">
            <textarea
              value={promptJa}
              onChange={(e) => setPromptJa(e.target.value)}
              className="w-full bg-[#FAF9F6] border border-[#E5E5E5] text-[#333333] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#2C4A73] font-mono min-h-[300px] resize-y"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={handleResetPrompt}
                className="bg-white hover:bg-[#FAF9F6] text-[#666666] border border-[#CCCCCC] px-4 py-2 rounded text-sm font-bold flex items-center transition-colors shadow-sm"
              >
                <RotateCcw className="w-4 h-4 mr-2" />
                初期状態に戻す
              </button>
              <button
                onClick={handleSavePrompt}
                className="bg-[#2C4A73] hover:bg-[#1E3A8A] text-white px-6 py-2 rounded text-sm font-bold flex items-center transition-colors shadow-sm"
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
