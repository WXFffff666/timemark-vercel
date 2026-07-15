/** 跳过导航链接 — 键盘用户可直达主内容 */
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[200] focus:px-4 focus:py-2 focus:rounded-xl focus:bg-primary-600 focus:text-white focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-white"
    >
      跳过导航，直达主要内容
    </a>
  );
}
