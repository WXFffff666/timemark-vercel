import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { QrCode } from 'lucide-react';

/**
 * 渠道绑定二维码：凡是凭据需要在手机上获取的渠道（WxPusher 关注公众号、Server酱
 * 扫码登录、Bark 装 App……），把官方集成页转成二维码展示，用户拿手机扫一下就能
 * 在手机浏览器里完成注册/取 Token，不用再手动传文件或抄链接。
 *
 * 生成完全在前端完成（qrcode 包 → dataURL），链接不会发往任何服务器。
 */
export function ChannelQr({ url, name }: { url: string; name?: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    QRCode.toDataURL(url, { width: 176, margin: 1, errorCorrectionLevel: 'M' })
      .then((data) => {
        if (!cancelled) setDataUrl(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (failed) return null;

  return (
    <div className="flex items-center gap-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60 p-3 ring-1 ring-black/5 dark:ring-white/10">
      {dataUrl ? (
        <img src={dataUrl} alt={`${name ?? '官方页面'}绑定二维码`} className="w-[88px] h-[88px] rounded-lg bg-white p-1" />
      ) : (
        <div className="w-[88px] h-[88px] rounded-lg bg-slate-200/60 dark:bg-slate-700/50 animate-pulse" />
      )}
      <div className="text-sm">
        <div className="font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
          <QrCode size={15} className="shrink-0" /> 手机扫码直达
        </div>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          用手机浏览器扫码打开{name ? ` ${name} ` : ' '}官方页，在手机上完成注册并获取 Token。
        </p>
      </div>
    </div>
  );
}
