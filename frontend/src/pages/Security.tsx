import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ThemeToggle } from '@/components/ThemeToggle';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { Shield, Monitor, Globe, Ban, Key, Clock, Trash2, ArrowLeft, Fingerprint, Plus } from 'lucide-react';
import {
  isPasskeySupported,
  listPasskeys,
  registerPasskey,
  removePasskey,
  type PasskeyCredential,
} from '@/lib/webauthn';

interface SessionRow {
  id: number;
  deviceFingerprint?: string;
  isTrusted: boolean;
  expiresAt: string;
  createdAt: string;
  isCurrent: boolean;
}

export default function Security() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [ipBans, setIpBans] = useState<any[]>([]);
  const [whitelistEnabled, setWhitelistEnabled] = useState(false);
  const [whitelistIps, setWhitelistIps] = useState('');
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [deployInfo, setDeployInfo] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [passkeys, setPasskeys] = useState<PasskeyCredential[]>([]);
  const [passkeyName, setPasskeyName] = useState('');
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const passkeySupported = isPasskeySupported();

  const [loadError, setLoadError] = useState('');

  const load = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [sess, ev, bans, wl, totp, deploy, keys] = await Promise.all([
        api.get<SessionRow[]>('/security/sessions'),
        api.get<any[]>('/security/events'),
        api.get<any[]>('/security/ip-bans'),
        api.get<{ enabled: boolean; ips: string[] }>('/security/ip-whitelist'),
        api.get<{ enabled: boolean }>('/security/totp/status'),
        api.get<any>('/security/deploy-info'),
        listPasskeys().catch(() => []),
      ]);
      setSessions(Array.isArray(sess) ? sess : []);
      setEvents(Array.isArray(ev) ? ev : []);
      setIpBans(Array.isArray(bans) ? bans : []);
      setWhitelistEnabled(!!wl?.enabled);
      setWhitelistIps((wl?.ips || []).join('\n'));
      setTotpEnabled(!!totp?.enabled);
      setDeployInfo(deploy ?? null);
      setPasskeys(Array.isArray(keys) ? keys : []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '加载失败');
      setSessions([]);
      setEvents([]);
      setIpBans([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const revokeSession = async (id: number) => {
    if (!confirm('确定踢出该设备？')) return;
    await api.delete(`/security/sessions/${id}`);
    load();
  };

  const saveWhitelist = async () => {
    const ips = whitelistIps.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    await api.put('/security/ip-whitelist', { enabled: whitelistEnabled, ips });
    alert('IP 白名单已保存');
  };

  const setupTotp = async () => {
    const data = await api.post<{ qrDataUrl: string }>('/security/totp/setup', {});
    setQrDataUrl(data.qrDataUrl);
  };

  const enableTotp = async () => {
    await api.post('/security/totp/enable', { code: totpCode });
    setTotpEnabled(true);
    setQrDataUrl('');
    alert('双因素认证已启用');
  };

  const unbanIp = async (ip: string) => {
    await api.delete(`/security/ip-bans/${encodeURIComponent(ip)}`);
    load();
  };

  const handleRegisterPasskey = async () => {
    if (!passkeySupported) {
      alert('当前浏览器不支持 Passkey');
      return;
    }
    setPasskeyBusy(true);
    try {
      await registerPasskey(passkeyName.trim() || '我的设备');
      setPasskeyName('');
      alert('Passkey 注册成功');
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Passkey 注册失败');
    } finally {
      setPasskeyBusy(false);
    }
  };

  const handleRemovePasskey = async (id: string) => {
    if (!confirm('确定删除此 Passkey？删除后将无法用它登录。')) return;
    try {
      await removePasskey(id);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : '删除失败');
    }
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><div className="animate-spin h-8 w-8 border-b-2 border-blue-500 rounded-full" /></div>;
  }

  return (
    <div className="min-h-screen pb-20 md:pb-8">
      <header className="sticky top-0 z-20 backdrop-blur border-b border-white/10 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)} title="返回">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <Shield className="w-5 h-5" />
          <h1 className="font-semibold">安全中心</h1>
        </div>
        <div className="flex gap-2"><ThemeToggle /><Button variant="outline" size="sm" onClick={() => navigate('/settings')}>设置</Button></div>
      </header>

      <main className="max-w-4xl mx-auto p-4 space-y-4">
        {loadError && (
          <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {loadError}
            <Button variant="link" size="sm" className="ml-2 h-auto p-0" onClick={load}>重试</Button>
          </div>
        )}
        {deployInfo && (
          <Card>
            <CardHeader><CardTitle className="text-base">部署状态</CardTitle></CardHeader>
            <CardContent className="text-sm space-y-1 text-slate-600 dark:text-slate-300">
              <p>版本: {deployInfo.version} · 平台: {deployInfo.platform}</p>
              <p>Turnstile: {deployInfo.turnstileConfigured ? '已配置' : '未配置'}</p>
              <p>Cron Secret: {deployInfo.cronSecretConfigured ? '已配置' : '未配置'}</p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2"><Monitor className="w-4 h-4" />活跃会话</CardTitle>
            <Button size="sm" variant="outline" onClick={() => navigate('/login-history')}>登录历史</Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/50 text-sm">
                <div>
                  <p>{s.deviceFingerprint?.slice(0, 20) || '未知设备'} {s.isCurrent && <span className="text-green-600">(当前)</span>}</p>
                  <p className="text-xs text-slate-500">{new Date(s.createdAt).toLocaleString()}</p>
                </div>
                {!s.isCurrent && <Button size="sm" variant="ghost" onClick={() => revokeSession(s.id)}><Trash2 className="w-4 h-4" /></Button>}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Fingerprint className="w-4 h-4" />Passkey（无密码登录）</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              状态: {passkeys.length > 0 ? `已注册 ${passkeys.length} 个` : '未注册'}
              {!passkeySupported && ' · 当前浏览器不支持'}
            </p>
            {passkeySupported && (
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  placeholder="设备名称（如：iPhone / MacBook）"
                  value={passkeyName}
                  onChange={(e) => setPasskeyName(e.target.value)}
                  disabled={passkeyBusy}
                />
                <Button size="sm" onClick={handleRegisterPasskey} disabled={passkeyBusy}>
                  <Plus className="w-4 h-4 mr-1" />
                  {passkeyBusy ? '注册中...' : '注册 Passkey'}
                </Button>
              </div>
            )}
            {passkeys.length > 0 && (
              <div className="space-y-2">
                {passkeys.map((pk) => (
                  <div key={pk.id} className="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/50 text-sm">
                    <div>
                      <p className="font-medium">{pk.deviceName || 'Passkey'}</p>
                      <p className="text-xs text-slate-500">
                        注册于 {new Date(pk.createdAt).toLocaleString()}
                        {pk.lastUsedAt ? ` · 最近使用 ${new Date(pk.lastUsedAt).toLocaleString()}` : ''}
                      </p>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => handleRemovePasskey(pk.id)}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-slate-500">
              注册后可在登录页使用「Passkey 登录」。需 HTTPS 环境（生产域名已支持）。
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Key className="w-4 h-4" />双因素认证 (TOTP)</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">状态: {totpEnabled ? '已启用' : '未启用'}</p>
            {!totpEnabled && (
              <>
                <Button size="sm" onClick={setupTotp}>生成二维码</Button>
                {qrDataUrl && <img src={qrDataUrl} alt="TOTP QR" className="w-40 h-40" />}
                <div className="flex gap-2">
                  <Input placeholder="6位验证码" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} />
                  <Button onClick={enableTotp}>启用</Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Globe className="w-4 h-4" />IP 白名单</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={whitelistEnabled} onChange={(e) => setWhitelistEnabled(e.target.checked)} />
              启用白名单（仅列出的 IP 可登录）
            </label>
            <textarea className="w-full min-h-[80px] p-2 rounded border text-sm dark:bg-slate-900" value={whitelistIps} onChange={(e) => setWhitelistIps(e.target.value)} placeholder="每行一个 IP" />
            <Button size="sm" onClick={saveWhitelist}>保存</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Ban className="w-4 h-4" />IP 封禁列表</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {ipBans.length === 0 ? <p className="text-sm text-slate-500">当前无封禁 IP</p> : ipBans.map((b) => (
              <div key={b.ip} className="flex justify-between items-center text-sm p-2 bg-red-50 dark:bg-red-900/20 rounded">
                <span>{b.ip} · {b.geo} · 至 {new Date(b.lockedUntil).toLocaleString()}</span>
                <Button size="sm" variant="outline" onClick={() => unbanIp(b.ip)}>解封</Button>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Clock className="w-4 h-4" />安全事件时间线</CardTitle></CardHeader>
          <CardContent className="space-y-2 max-h-64 overflow-y-auto">
            {events.map((e) => (
              <div key={e.id} className="text-sm border-l-2 border-blue-400 pl-3 py-1">
                <p className="font-medium">{e.event_type}</p>
                <p className="text-xs text-slate-500">{e.ip_address} · {new Date(e.created_at).toLocaleString()}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </main>
      <MobileBottomNav />
    </div>
  );
}
