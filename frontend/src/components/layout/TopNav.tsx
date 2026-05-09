"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Video, Settings, LayoutDashboard } from "lucide-react";
import clsx from "clsx";

export default function TopNav() {
  const pathname = usePathname();

  return (
    <header className="bg-white border-b border-[#E5E5E5] sticky top-0 z-50">
      <div className="max-w-[1000px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between overflow-x-auto whitespace-nowrap scrollbar-hide">
        <div className="flex items-center space-x-4 sm:space-x-8">
          <Link href="/" className="flex items-center">
            <Video className="w-5 h-5 text-[#2C4A73] mr-2" />
            <span className="font-bold text-[#333333] tracking-wide text-sm">動画添削AIシステム</span>
          </Link>
          
          <nav className="flex space-x-1">
            <Link
              href="/"
              className={clsx(
                "px-3 py-1.5 rounded text-sm font-medium transition-colors flex items-center",
                pathname === "/"
                  ? "bg-[#F4F6F8] text-[#2C4A73]"
                  : "text-[#666666] hover:bg-[#FAF9F6] hover:text-[#333333]"
              )}
            >
              <LayoutDashboard className="w-4 h-4 mr-1.5" />
              ダッシュボード
            </Link>
            <Link
              href="/settings"
              className={clsx(
                "px-3 py-1.5 rounded text-sm font-medium transition-colors flex items-center",
                pathname === "/settings"
                  ? "bg-[#F4F6F8] text-[#2C4A73]"
                  : "text-[#666666] hover:bg-[#FAF9F6] hover:text-[#333333]"
              )}
            >
              <Settings className="w-4 h-4 mr-1.5" />
              システム設定
            </Link>
          </nav>
        </div>
        
        <div className="hidden sm:block text-xs text-[#999999] font-medium border border-[#E5E5E5] px-2 py-1 rounded">
          CS担当者用ツール
        </div>
      </div>
    </header>
  );
}
