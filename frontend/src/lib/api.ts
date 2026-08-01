/** バックエンドのベースURL。末尾スラッシュは取り除いて返す。 */
export function getApiUrl(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
  return raw.replace(/\/$/, "");
}

/** デフォルトのチェックプロンプトをバックエンドから取得する。
 * プロンプト本文の定義元は backend/prompt.py の1箇所のみ（フロント側に複製を持たない）。 */
export interface CallToActionCheck {
  ok: boolean;
  count: number;
  actions: string[];
  /** 注意書きとみなして訴求文から除外した行 */
  skipped: string[];
  reason: string;
}

/** スプレッドシートの訴求文リストが読み取れるかを事前に確認する。
 * 動画を1本消費しなくても設定画面でその場で検証できる。 */
export async function checkCallToActionList(url: string): Promise<CallToActionCheck> {
  const response = await fetch(`${getApiUrl()}/call-to-action-check?url=${encodeURIComponent(url)}`);
  if (!response.ok) {
    throw new Error(`確認に失敗しました (HTTP ${response.status})`);
  }
  return response.json();
}

export async function fetchDefaultPrompt(): Promise<string> {
  const response = await fetch(`${getApiUrl()}/default-prompt`);
  if (!response.ok) {
    throw new Error(`デフォルトプロンプトの取得に失敗しました (HTTP ${response.status})`);
  }
  const data = await response.json();
  if (typeof data?.prompt !== "string") {
    throw new Error("デフォルトプロンプトの形式が不正です。");
  }
  return data.prompt;
}
