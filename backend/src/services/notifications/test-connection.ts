import axios from 'axios';
import { getChannelTemplate } from './channels.config.js';

export interface TestConnectionResult {
  success: boolean;
  message: string;
  details?: string;
}

export async function testConnection(config: {
  type: string;
  configMethod: 'webhook' | 'token' | 'plugin';
  webhook?: string;
  token?: string;
  chatId?: string;
  secret?: string;
  sessionData?: string;
}): Promise<TestConnectionResult> {
  const { type, configMethod, webhook, token, chatId, secret, sessionData } = config;

  try {
    switch (configMethod) {
      case 'webhook':
        return await testWebhookChannel(webhook!, secret);
      
      case 'token':
        return await testTokenChannel(type, token!, chatId, webhook);
      
      case 'plugin':
        return await testPluginChannel(type, sessionData);
      
      default:
        return { success: false, message: '未知的配置方式' };
    }
  } catch (error: any) {
    console.error(`[TestConnection] ${type} (${configMethod}) error:`, error?.message || error);
    const details = error.response?.data 
      ? JSON.stringify(error.response.data) 
      : error.code ? `Error code: ${error.code}` : undefined;
    return { 
      success: false, 
      message: error.message || `测试 ${type} 连接失败`,
      details
    };
  }
}

async function testWebhookChannel(webhook: string, secret?: string): Promise<TestConnectionResult> {
  if (!webhook) {
    return { success: false, message: 'Webhook URL 不能为空' };
  }

  try {
    const testMessage = {
      text: '🔔 TimeMark 测试消息',
      attachments: [{
        color: '#4F46E5',
        title: '连接测试成功',
        text: '您的渠道配置正确，可以接收事件提醒通知。',
        footer: 'TimeMark',
        ts: Math.floor(Date.now() / 1000)
      }]
    };

    const response = await axios.post(webhook, testMessage, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    if (response.status >= 200 && response.status < 300) {
      return { success: true, message: 'Webhook 连接成功' };
    } else {
      return { success: false, message: `服务器返回状态码: ${response.status}` };
    }
  } catch (error: any) {
    if (error.code === 'ECONNABORTED') {
      return { success: false, message: '连接超时，请检查 URL 是否正确' };
    }
    if (error.response) {
      return { success: false, message: `HTTP ${error.response.status}: ${error.response.statusText}` };
    }
    return { success: false, message: `连接失败: ${error.message}` };
  }
}

async function testTokenChannel(
  type: string, 
  token: string, 
  chatId?: string,
  fromEmail?: string
): Promise<TestConnectionResult> {
  if (!token) {
    return { success: false, message: 'Token 不能为空' };
  }

  switch (type) {
    case 'email':
    case 'resend':
      return await testEmailChannel(token, fromEmail!, chatId!);
    
    case 'smtp':
      return await testSmtpChannel(fromEmail!, token, chatId!);
    
    case 'telegram':
      return await testTelegramChannel(token, chatId!);
    
    case 'qmsg':
      return await testQmsgChannel(token, chatId!);
    
    case 'wxpusher':
      return await testWxpusherChannel(token, chatId!);
    
    case 'line':
      return await testLineChannel(token, chatId!);
    
    case 'nextcloud_talk':
    case 'mattermost':
    case 'matrix':
    case 'msteams':
    case 'nostr':
      // These channels require server_url + token + chat_id; validate presence
      if (!chatId) {
        return { success: false, message: `${type} 需要提供 Chat ID / Room Token` };
      }
      return { success: true, message: `${type} 配置格式正确（实际连通性将在发送时验证）` };
    
    case 'serverchan':
      return await testServerChanChannel(token);
    
    case 'pushplus':
      return await testPushPlusChannel(token, chatId);
    
    case 'bark':
      return await testBarkChannel(fromEmail!, token);
    
    case 'gotify':
      return await testGotifyChannel(fromEmail!, token);
    
    case 'meow':
      return await testMeowChannel(token);
    
    case 'pushme':
      return await testPushMeChannel(token);
    
    case 'ntfy':
      return await testNtfyChannel(fromEmail!, token);
    
    case 'pushover':
      return await testPushoverChannel(token, chatId!);
    
    default:
      return { success: false, message: `暂不支持测试 ${type} 渠道` };
  }
}

async function testEmailChannel(apiKey: string, fromEmail: string, toEmail: string): Promise<TestConnectionResult> {
  if (!apiKey || !toEmail) {
    return { success: false, message: 'API Key 和收件邮箱不能为空' };
  }

  // 如果发件邮箱为空，使用Resend测试地址（仅能发送到自己的邮箱）
  const effectiveFrom = fromEmail || 'onboarding@resend.dev';

  try {
    const { Resend } = await import('resend');
    const resend = new Resend(apiKey);
    
    const { error } = await resend.emails.send({
      from: effectiveFrom,
      to: toEmail,
      subject: '🔔 TimeMark 连接测试',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #4F46E5;">✅ 连接测试成功</h2>
          <p>您的邮件渠道配置正确，可以接收事件提醒通知。</p>
          <p style="color: #64748B; font-size: 12px;">TimeMark 自动发送</p>
        </div>
      `
    });

    if (error) {
      return { success: false, message: `发送失败: ${error.message}` };
    }

    return { success: true, message: '测试邮件已发送，请检查收件箱' };
  } catch (error: any) {
    if (error.message?.includes('Invalid API key')) {
      return { success: false, message: 'API Key 无效，请检查是否正确' };
    }
    throw error;
  }
}

async function testTelegramChannel(botToken: string, chatId: string): Promise<TestConnectionResult> {
  if (!botToken || !chatId) {
    return { success: false, message: 'Bot Token 和 Chat ID 都不能为空' };
  }

  const telegramTokenRegex = /^\d+:[\w-]+$/;
  if (!telegramTokenRegex.test(botToken)) {
    return { success: false, message: 'Bot Token 格式不正确，应为数字:字母组合' };
  }

  try {
    const response = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`, {
      timeout: 10000
    });

    if (!response.data.ok) {
      return { success: false, message: 'Token 无效' };
    }

    const botInfo = response.data.result;
    
    const chatResponse = await axios.get(`https://api.telegram.org/bot${botToken}/getChat?chat_id=${chatId}`, {
      timeout: 10000
    });

    if (!chatResponse.data.ok) {
      return { success: false, message: 'Chat ID 无效或机器人无权限访问该聊天' };
    }

    return { 
      success: true, 
      message: `已连接到机器人 ${botInfo.username}` 
    };
  } catch (error: any) {
    if (error.response?.data?.error_code === 401) {
      return { success: false, message: 'Bot Token 无效' };
    }
    if (error.response?.data?.error_code === 400) {
      return { success: false, message: 'Chat ID 格式不正确' };
    }
    throw error;
  }
}

async function testQmsgChannel(key: string, qq?: string): Promise<TestConnectionResult> {
  if (!key) {
    return { success: false, message: 'Qmsg Key 不能为空' };
  }

  try {
    const url = qq 
      ? `https://qmsg.zendee.cn/send/${key}?qq=${qq}`
      : `https://qmsg.zendee.cn/send/${key}`;
    
    const response = await axios.post(url, {
      msg: '🔔 TimeMark 连接测试'
    }, {
      timeout: 10000
    });

    if (response.data.code === 0) {
      return { success: true, message: 'Qmsg 连接成功' };
    } else {
      return { success: false, message: `发送失败: ${response.data.text}` };
    }
  } catch (error: any) {
    return { success: false, message: `连接失败: ${error.message}` };
  }
}

async function testWxpusherChannel(appToken: string, uid: string): Promise<TestConnectionResult> {
  if (!appToken || !uid) {
    return { success: false, message: 'AppToken 和 UID 都不能为空' };
  }

  try {
    const response = await axios.post('http://wxpusher.zjiecode.com/api/send/message', {
      appToken,
      content: '🔔 TimeMark 连接测试',
      uids: [uid]
    }, {
      timeout: 10000
    });

    if (response.data.code === 1000) {
      return { success: true, message: 'WxPusher 连接成功' };
    } else if (response.data.code === 1001) {
      return { success: false, message: 'AppToken 无效' };
    } else if (response.data.code === 1002) {
      return { success: false, message: 'UID 无效' };
    } else {
      return { success: false, message: `发送失败: ${response.data.msg}` };
    }
  } catch (error: any) {
    return { success: false, message: `连接失败: ${error.message}` };
  }
}

async function testLineChannel(channelToken: string, userId: string): Promise<TestConnectionResult> {
  if (!channelToken || !userId) {
    return { success: false, message: 'Channel Access Token 和 User ID 都不能为空' };
  }

  try {
    const response = await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: userId, messages: [{ type: 'text', text: '🔔 TimeMark 连接测试' }] },
      {
        headers: { 
          'Authorization': `Bearer ${channelToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    if (response.status === 200) {
      return { success: true, message: 'LINE 连接成功' };
    } else {
      return { success: false, message: `HTTP ${response.status}` };
    }
  } catch (error: any) {
    if (error.response?.status === 401) {
      return { success: false, message: 'Channel Access Token 无效' };
    }
    if (error.response?.status === 400 && error.response?.data?.message?.includes('Invalid destination')) {
      return { success: false, message: 'User ID 无效' };
    }
    throw error;
  }
}

async function testPluginChannel(type: string, sessionData?: string): Promise<TestConnectionResult> {
  if (!sessionData) {
    return { success: false, message: '需要先完成扫码授权' };
  }

  try {
    const parsed = JSON.parse(sessionData);
    
    switch (type) {
      case 'wechat_personal':
      case 'whatsapp':
      case 'qq_bot':
      case 'signal':
      case 'zalo':
      case 'imessage':
      case 'clawbot':
        if (parsed.authenticated === true) {
          const template = getChannelTemplate(type);
          return { 
            success: true, 
            message: `${template?.name || type} 已认证` 
          };
        }
        return { success: false, message: '认证会话已过期，请重新扫码授权' };
      
      default:
        return { success: false, message: `暂不支持测试 ${type} 插件渠道` };
    }
  } catch {
    return { success: false, message: '会话数据格式无效' };
  }
}

async function testServerChanChannel(sendKey: string): Promise<TestConnectionResult> {
  if (!sendKey) {
    return { success: false, message: 'SendKey 不能为空' };
  }

  try {
    const response = await axios.post(
      `https://sctapi.ftqq.com/${sendKey}.send`,
      new URLSearchParams({ title: 'TimeMark 连接测试', desp: '您的 Server酱 渠道配置正确。' }),
      { timeout: 10000 }
    );

    if (response.data?.code === 0) {
      return { success: true, message: 'Server酱 连接成功' };
    } else {
      return { success: false, message: `发送失败: ${response.data?.message || '未知错误'}` };
    }
  } catch (error: any) {
    if (error.response?.status === 401 || error.response?.data?.code === 40001) {
      return { success: false, message: 'SendKey 无效' };
    }
    return { success: false, message: `连接失败: ${error.message}` };
  }
}

async function testPushPlusChannel(token: string, topic?: string): Promise<TestConnectionResult> {
  if (!token) {
    return { success: false, message: 'Token 不能为空' };
  }

  try {
    const payload: any = {
      token,
      title: 'TimeMark 连接测试',
      content: '您的 PushPlus 渠道配置正确。',
    };
    if (topic) payload.topic = topic;

    const response = await axios.post('http://www.pushplus.plus/send', payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });

    if (response.data?.code === 200) {
      return { success: true, message: 'PushPlus 连接成功' };
    } else {
      return { success: false, message: `发送失败: ${response.data?.msg || '未知错误'}` };
    }
  } catch (error: any) {
    return { success: false, message: `连接失败: ${error.message}` };
  }
}

async function testBarkChannel(serverUrl: string, deviceKey: string): Promise<TestConnectionResult> {
  if (!serverUrl || !deviceKey) {
    return { success: false, message: '服务器地址和设备密钥不能为空' };
  }

  try {
    const baseUrl = serverUrl.replace(/\/+$/, '');
    const response = await axios.get(
      `${baseUrl}/${encodeURIComponent(deviceKey)}/TimeMark+连接测试/渠道配置正确`,
      { timeout: 10000 }
    );

    if (response.data?.code === 200) {
      return { success: true, message: 'Bark 连接成功' };
    } else {
      return { success: false, message: `发送失败: ${response.data?.message || '未知错误'}` };
    }
  } catch (error: any) {
    if (error.response?.status === 400) {
      return { success: false, message: '设备密钥无效' };
    }
    return { success: false, message: `连接失败: ${error.message}` };
  }
}

async function testGotifyChannel(serverUrl: string, appToken: string): Promise<TestConnectionResult> {
  if (!serverUrl || !appToken) {
    return { success: false, message: '服务器地址和 App Token 不能为空' };
  }

  try {
    const baseUrl = serverUrl.replace(/\/+$/, '');
    const response = await axios.post(
      `${baseUrl}/message`,
      { title: 'TimeMark 连接测试', message: '您的 Gotify 渠道配置正确。', priority: 5 },
      {
        headers: { 'X-Gotify-Key': appToken, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );

    if (response.status >= 200 && response.status < 300) {
      return { success: true, message: 'Gotify 连接成功' };
    } else {
      return { success: false, message: `服务器返回状态码: ${response.status}` };
    }
  } catch (error: any) {
    if (error.response?.status === 401) {
      return { success: false, message: 'App Token 无效' };
    }
    return { success: false, message: `连接失败: ${error.message}` };
  }
}

async function testMeowChannel(pushKey: string): Promise<TestConnectionResult> {
  if (!pushKey) {
    return { success: false, message: 'Push Key 不能为空' };
  }

  try {
    const response = await axios.get(
      `https://api.day.app/${encodeURIComponent(pushKey)}/TimeMark+连接测试/渠道配置正确`,
      { timeout: 10000 }
    );

    if (response.data?.code === 200) {
      return { success: true, message: 'Meow 连接成功' };
    } else {
      return { success: false, message: `发送失败: ${response.data?.message || '未知错误'}` };
    }
  } catch (error: any) {
    if (error.response?.status === 400) {
      return { success: false, message: 'Push Key 无效' };
    }
    return { success: false, message: `连接失败: ${error.message}` };
  }
}

async function testPushMeChannel(pushKey: string): Promise<TestConnectionResult> {
  if (!pushKey) {
    return { success: false, message: 'Push Key 不能为空' };
  }

  try {
    const response = await axios.post(
      'https://push.i-i.me/',
      new URLSearchParams({ push_key: pushKey, title: 'TimeMark 连接测试', content: '您的 PushMe 渠道配置正确。' }),
      { timeout: 10000 }
    );

    if (response.data?.code === 200 || response.data?.success === true) {
      return { success: true, message: 'PushMe 连接成功' };
    } else {
      return { success: false, message: `发送失败: ${response.data?.msg || response.data?.message || '未知错误'}` };
    }
  } catch (error: any) {
    return { success: false, message: `连接失败: ${error.message}` };
  }
}

async function testNtfyChannel(serverUrl: string, topic: string): Promise<TestConnectionResult> {
  if (!serverUrl || !topic) {
    return { success: false, message: '服务器地址和 Topic 不能为空' };
  }

  try {
    const baseUrl = serverUrl.replace(/\/+$/, '');
    const response = await axios.post(
      `${baseUrl}/${encodeURIComponent(topic)}`,
      'TimeMark 连接测试 - 渠道配置正确',
      {
        headers: { Title: 'TimeMark Test', Priority: '3' },
        timeout: 10000,
      }
    );

    if (response.status >= 200 && response.status < 300) {
      return { success: true, message: 'Ntfy 连接成功' };
    } else {
      return { success: false, message: `服务器返回状态码: ${response.status}` };
    }
  } catch (error: any) {
    if (error.response?.status === 401 || error.response?.status === 403) {
      return { success: false, message: '认证失败，请检查 Topic 权限' };
    }
    return { success: false, message: `连接失败: ${error.message}` };
  }
}

async function testPushoverChannel(userKey: string, appToken: string): Promise<TestConnectionResult> {
  if (!userKey || !appToken) {
    return { success: false, message: 'User Key 和 App Token 不能为空' };
  }

  try {
    const response = await axios.post(
      'https://api.pushover.net/1/users/validate.json',
      new URLSearchParams({ token: appToken, user: userKey }),
      { timeout: 10000 }
    );

    if (response.data?.status === 1) {
      return { success: true, message: 'Pushover 连接成功' };
    } else {
      return { success: false, message: `验证失败: ${response.data?.errors?.join(', ') || '未知错误'}` };
    }
  } catch (error: any) {
    if (error.response?.status === 401) {
      return { success: false, message: 'App Token 无效' };
    }
    if (error.response?.data?.errors) {
      return { success: false, message: `验证失败: ${error.response.data.errors.join(', ')}` };
    }
    return { success: false, message: `连接失败: ${error.message}` };
  }
}

async function testSmtpChannel(smtpHost: string, password: string, fromEmail: string): Promise<TestConnectionResult> {
  if (!smtpHost || !password || !fromEmail) {
    return { success: false, message: 'SMTP 服务器、密码和发件邮箱都不能为空' };
  }

  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransport({
      host: smtpHost,
      port: 587,
      secure: false,
      auth: {
        user: fromEmail,
        pass: password,
      },
    });

    await transporter.verify();
    return { success: true, message: 'SMTP 连接成功' };
  } catch (error: any) {
    if (error.code === 'EAUTH') {
      return { success: false, message: 'SMTP 认证失败，请检查邮箱和密码/授权码' };
    }
    if (error.code === 'ECONNREFUSED') {
      return { success: false, message: 'SMTP 服务器连接被拒绝，请检查服务器地址' };
    }
    return { success: false, message: `SMTP 连接失败: ${error.message}` };
  }
}

