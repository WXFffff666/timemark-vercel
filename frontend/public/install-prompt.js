/**
 * PWA 安装横幅（checkbox 85）。
 *
 * 这个文件之前**根本不存在**：index.html 里只有 `<script defer src="/install-prompt.js">`，
 * 于是每次加载页面都会 404（dev 与生产都是）。后果有两个 —— almanac / almanac-advanced
 * 两条用例断言「无 console error」因此必然失败；安装横幅也从没出现过。
 *
 * 语言跟随 i18n 的存储键（`localStorage.lang`，'zh' | 'en'），与 index.html 的
 * `lang="zh-CN"` 默认值一致。这是独立于 React 的原生脚本（横幅要在 React 挂载前就能出现），
 * 所以文案在这里各写一份，而不是从 i18n 资源里取。
 */
(function () {
  var BANNER_ID = 'timemark-install-banner';
  var STORAGE_KEY = 'lang';

  function isEnglish() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === 'en';
    } catch (e) {
      // 隐私模式 / 存储被禁用：退回默认中文
      return false;
    }
  }

  function removeBanner() {
    var el = document.getElementById(BANNER_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function buildBanner(title, installLabel, dismissLabel) {
    var banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', title);
    banner.style.cssText = [
      'position:fixed', 'left:50%', 'transform:translateX(-50%)', 'bottom:1.25rem',
      'z-index:9999', 'display:flex', 'align-items:center', 'gap:0.75rem',
      'max-width:min(92vw,26rem)', 'padding:0.875rem 1rem',
      'border-radius:1rem', 'border:1px solid rgba(15,23,42,0.08)',
      'background:#fff', 'color:#0f172a', 'box-shadow:0 10px 30px rgba(15,23,42,0.18)',
      'font:500 0.875rem/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    ].join(';');

    var text = document.createElement('span');
    text.style.cssText = 'flex:1;min-width:0';
    text.textContent = title;

    function button(label, primary) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = primary
        ? 'flex:none;padding:0.5rem 0.875rem;border-radius:0.625rem;border:1px solid #2463eb;background:#2463eb;color:#fff;font:inherit;cursor:pointer'
        : 'flex:none;padding:0.5rem 0.75rem;border-radius:0.625rem;border:1px solid rgba(15,23,42,0.15);background:transparent;color:#475569;font:inherit;cursor:pointer';
      return b;
    }

    var installBtn = button(installLabel, true);
    var dismissBtn = button(dismissLabel, false);

    banner.appendChild(text);
    banner.appendChild(installBtn);
    banner.appendChild(dismissBtn);
    return { banner: banner, installBtn: installBtn, dismissBtn: dismissBtn };
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    // 抑制 Chrome 自带的小横幅，改用我们自己的（可关闭、文案本地化）
    event.preventDefault();

    if (document.getElementById(BANNER_ID)) return;
    if (!document.body) return;

    var parts = isEnglish()
      ? buildBanner('Install TimeMark on your desktop', 'Install', 'Later')
      : buildBanner('安装 TimeMark 到桌面', '安装', '稍后');

    parts.installBtn.addEventListener('click', function () {
      removeBanner();
      // prompt() 只能调用一次；用户拒绝后浏览器不再发 beforeinstallprompt
      if (typeof event.prompt === 'function') event.prompt();
    });
    parts.dismissBtn.addEventListener('click', removeBanner);

    document.body.appendChild(parts.banner);
  });

  // 安装完成后（或被浏览器静默安装后）横幅必须消失
  window.addEventListener('appinstalled', removeBanner);
})();