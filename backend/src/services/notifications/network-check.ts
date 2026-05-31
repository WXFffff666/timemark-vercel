import axios from 'axios';

// 每个渠道对应的检测 URL（只需要能连上就行，不需要认证）
const CHANNEL_ENDPOINTS: Record<string, string> = {
  // 国际渠道（中国大陆可能无法访问）
  telegram: 'https://api.telegram.org',
  discord: 'https://discord.com',
  slack: 'https://hooks.slack.com',
  line: 'https://api.line.me',
  whatsapp: 'https://web.whatsapp.com',
  signal: 'https://signal.org',
  msteams: 'https://smba.trafficmanager.net',
  googlechat: 'https://chat.googleapis.com',
  matrix: 'https://matrix.org',
  nostr: 'https://relay.damus.io',
  pushover: 'https://api.pushover.net',
  twitch: 'https://api.twitch.tv',
  
  // 国内渠道（通常可以访问）
  feishu: 'https://open.feishu.cn',
  wecom: 'https://qyapi.weixin.qq.com',
  dingtalk: 'https://oapi.dingtalk.com',
  wxpusher: 'https://wxpusher.zjiecode.com',
  serverchan: 'https://sctapi.ftqq.com',
  pushplus: 'https://www.pushplus.plus',
  bark: 'https://api.day.app',
  qmsg: 'https://qmsg.zendee.cn',
  
  // 自建服务（取决于用户配置）
  ntfy: 'https://ntfy.sh',
  gotify: '', // 用户自建，无法预检
  mattermost: '', // 用户自建
  nextcloud_talk: '', // 用户自建
  synologychat: '', // 局域网
  apprise: '', // 用户自建
};

export interface NetworkCheckResult {
  channel: string;
  reachable: boolean;
  latency: number | null; // ms
  error?: string;
}

/**
 * 检测单个渠道的网络可达性
 */
async function checkEndpoint(channel: string, url: string): Promise<NetworkCheckResult> {
  if (!url) {
    return { channel, reachable: true, latency: null }; // 自建服务默认可达
  }
  
  const start = Date.now();
  try {
    await axios.head(url, { timeout: 5000, maxRedirects: 0, validateStatus: () => true });
    return { channel, reachable: true, latency: Date.now() - start };
  } catch (error: any) {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return { channel, reachable: false, latency: null, error: '连接超时（可能被防火墙拦截）' };
    }
    if (error.code === 'ENOTFOUND') {
      return { channel, reachable: false, latency: null, error: 'DNS 解析失败' };
    }
    if (error.code === 'ECONNREFUSED') {
      return { channel, reachable: false, latency: null, error: '连接被拒绝' };
    }
    // 其他错误（如 SSL 错误）但能连上 = 可达
    if (error.response) {
      return { channel, reachable: true, latency: Date.now() - start };
    }
    return { channel, reachable: false, latency: null, error: error.message || '未知错误' };
  }
}

/**
 * 批量检测所有渠道的网络可达性
 */
export async function checkAllChannels(): Promise<NetworkCheckResult[]> {
  const checks = Object.entries(CHANNEL_ENDPOINTS).map(([channel, url]) => 
    checkEndpoint(channel, url)
  );
  return Promise.all(checks);
}

/**
 * 检测指定渠道的网络可达性
 */
export async function checkChannel(channel: string): Promise<NetworkCheckResult> {
  const url = CHANNEL_ENDPOINTS[channel] || '';
  return checkEndpoint(channel, url);
}

export { CHANNEL_ENDPOINTS };
