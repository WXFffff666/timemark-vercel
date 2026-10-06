import axios from 'axios';
import crypto from 'crypto';
import { getChannelTemplate } from './channels.config.js';
import { sendSynologyChatNotification } from './synologychat.service.js';
import { sendTwitchNotification } from './twitch.service.js';
import { sendIRCNotification } from './irc.service.js';
import { buildServerChan3Url } from './serverchan3.service.js';
import { buildXizhiUrl } from './xizhi.service.js';
import { buildAnPushUrl } from './anpush.service.js';
import { normalizeChanifyBaseUrl } from './chanify.service.js';
import { isPushbackSuccess } from './pushback.service.js';
import { SIMPLEPUSH_ENDPOINT } from './simplepush.service.js';
import { normalizeZulipOrgUrl } from './zulip.service.js';
import { sendFcmMessage } from './fcm.service.js';
import {
  testWhatsAppCloudChannel,
  testHomeAssistantChannel,
  testPushBulletChannel,
  testJoinChannel,
  testPushSaferChannel,
  testIftttChannel,
  testRevoltChannel,
  testOneSignalChannel,
  testSendgridChannel,
  testMailgunChannel,
  testVonageSmsChannel,
  testMessagebirdChannel,
  testAlertzyChannel,
} from './extended-channels.service.js';

export interface TestConnectionResult {
  success: boolean;
  message: string;
  latency?: number;
  details?: string;
}

function diagnoseError(error: any): { message: string; details?: string } {
  if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
    return { message: '连接超时', details: '请检查网络连接或服务器地址是否正确' };
  }
  if (error.code === 'ECONNREFUSED') {
    return { message: '无法连接到服务器', details: '请确认服务器正在运行' };
  }
  if (error.code === 'ENOTFOUND') {
    return { message: '域名解析失败', details: '请检查服务器地址是否正确' };
  }
  if (error.response?.status === 401 || error.response?.status === 403) {
    return { message: `认证失败 (HTTP ${error.response.status})`, details: '认证信息无效，请检查 Token/API Key' };
  }
  if (error.response?.status === 404) {
    return { message: 'HTTP 404', details: '服务器地址可能不正确' };
  }
  if (error.response) {
    const status = error.response.status;
    const statusText = error.response.statusText;
    return { message: statusText ? `HTTP ${status}: ${statusText}` : `HTTP ${status}` };
  }
  return { message: `连接失败: ${error.message}` };
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
        return await testWebhookChannel(type, webhook!, secret);
      
      case 'token':
        return await testTokenChannel(type, token!, chatId, webhook, secret);
      
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

const WEBHOOK_TEST_TEXT = '🔔 TimeMark 测试消息：渠道配置正确，可以接收事件提醒通知。';

function buildWebhookTestEvent() {
  return {
    name: 'TimeMark 连接测试',
    date: new Date().toISOString().slice(0, 10),
    type: 'other',
    reminderConfig: {},
  };
}

/**
 * B4: one-size-fits-all payloads hid provider errors. Feishu/WeCom/DingTalk answer
 * HTTP 200 with code/errcode in the BODY, so an invalid webhook used to be reported
 * as success. Each provider now gets its own payload and success signal.
 */
async function testWebhookChannel(type: string, webhook: string, secret?: string): Promise<TestConnectionResult> {
  if (!webhook) {
    return { success: false, message: 'Webhook URL 不能为空' };
  }

  const start = Date.now();
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const text = WEBHOOK_TEST_TEXT;

  try {
    switch (type) {
      // Discord returns 204 No Content on success — there is no body to validate.
      case 'discord': {
        const response = await axios.post(
          webhook,
          { content: text, username: 'TimeMark Bot' },
          { headers: jsonHeaders, timeout: 10000 },
        );
        const latency = Date.now() - start;
        if (response.status >= 200 && response.status < 300) {
          return { success: true, message: 'Discord Webhook 连接成功', latency };
        }
        return { success: false, message: `Discord 返回状态码: ${response.status}`, latency };
      }

      // Slack answers with the plain-text body `ok`; anything else is a failure.
      case 'slack': {
        const response = await axios.post(
          webhook,
          { text },
          { headers: jsonHeaders, timeout: 10000 },
        );
        const latency = Date.now() - start;
        const body = typeof response.data === 'string' ? response.data.trim() : '';
        if (response.status >= 200 && response.status < 300 && body === 'ok') {
          return { success: true, message: 'Slack Webhook 连接成功', latency };
        }
        return {
          success: false,
          message: `Slack 返回异常: ${body ? body.slice(0, 200) : `HTTP ${response.status}`}`,
          latency,
        };
      }

      // Feishu answers HTTP 200 with { code, msg } — code 0 is the only success.
      case 'feishu': {
        const response = await axios.post(
          webhook,
          { msg_type: 'text', content: { text } },
          { headers: jsonHeaders, timeout: 10000 },
        );
        const latency = Date.now() - start;
        const data = response.data;
        if (data?.code === 0) {
          return { success: true, message: '飞书 Webhook 连接成功', latency };
        }
        if (typeof data?.code === 'number') {
          return { success: false, message: `飞书返回错误 (code ${data.code}): ${data.msg || '未知错误'}`, latency };
        }
        return { success: false, message: `飞书返回了无法识别的响应 (HTTP ${response.status})`, latency };
      }

      // WeCom answers HTTP 200 with { errcode, errmsg } — errcode 0 is the only success.
      case 'wecom': {
        const response = await axios.post(
          webhook,
          { msgtype: 'text', text: { content: text } },
          { headers: jsonHeaders, timeout: 10000 },
        );
        const latency = Date.now() - start;
        const data = response.data;
        if (data?.errcode === 0) {
          return { success: true, message: '企业微信 Webhook 连接成功', latency };
        }
        if (typeof data?.errcode === 'number') {
          return {
            success: false,
            message: `企业微信返回错误 (errcode ${data.errcode}): ${data.errmsg || '未知错误'}`,
            latency,
          };
        }
        return { success: false, message: `企业微信返回了无法识别的响应 (HTTP ${response.status})`, latency };
      }

      // DingTalk: sign with `${timestamp}\n${secret}` HMAC-SHA256 exactly like dingtalk.service.ts.
      case 'dingtalk': {
        const timestamp = Date.now();
        let url = webhook;
        if (secret) {
          const sign = encodeURIComponent(
            crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64'),
          );
          url = `${webhook}&timestamp=${timestamp}&sign=${sign}`;
        }
        const response = await axios.post(
          url,
          { msgtype: 'text', text: { content: text } },
          { headers: jsonHeaders, timeout: 10000 },
        );
        const latency = Date.now() - start;
        const data = response.data;
        if (data?.errcode === 0) {
          return { success: true, message: '钉钉 Webhook 连接成功', latency };
        }
        if (typeof data?.errcode === 'number') {
          return {
            success: false,
            message: `钉钉返回错误 (errcode ${data.errcode}): ${data.errmsg || '未知错误'}`,
            latency,
          };
        }
        return { success: false, message: `钉钉返回了无法识别的响应 (HTTP ${response.status})`, latency };
      }

      // Google Chat echoes the created message ({ name, text }) on success.
      case 'googlechat': {
        const response = await axios.post(
          webhook,
          { text },
          { headers: jsonHeaders, timeout: 10000 },
        );
        const latency = Date.now() - start;
        if (
          response.status >= 200 &&
          response.status < 300 &&
          typeof response.data?.text === 'string' &&
          response.data.text.length > 0
        ) {
          return { success: true, message: 'Google Chat Webhook 连接成功', latency };
        }
        return { success: false, message: `Google Chat 返回了无法识别的响应 (HTTP ${response.status})`, latency };
      }

      // Synology Chat / Twitch / IRC each have a different payload — use their real senders.
      case 'synologychat': {
        await sendSynologyChatNotification(buildWebhookTestEvent(), webhook);
        return { success: true, message: 'Synology Chat 连接成功', latency: Date.now() - start };
      }

      case 'twitch': {
        await sendTwitchNotification(buildWebhookTestEvent(), webhook);
        return { success: true, message: 'Twitch 连接成功', latency: Date.now() - start };
      }

      case 'irc': {
        await sendIRCNotification(buildWebhookTestEvent(), webhook);
        return { success: true, message: 'IRC 连接成功', latency: Date.now() - start };
      }

      case 'rocketchat': {
        // Rocket.Chat answers HTTP 200 with `{"success":true}`; `success:false` must never be read as success.
        const response = await axios.post(
          webhook,
          { text: `${text}（Rocket.Chat 连接测试）` },
          { headers: jsonHeaders, timeout: 10000 },
        );
        const latency = Date.now() - start;
        const data = response.data as { success?: boolean; error?: string; message?: string } | null | undefined;
        const explicitFailure = data !== null && typeof data === 'object' && data.success === false;
        if (response.status >= 200 && response.status < 300 && !explicitFailure) {
          return { success: true, message: 'Rocket.Chat 连接成功', latency };
        }
        const providerMessage = data !== null && typeof data === 'object' ? data.error || data.message : undefined;
        return {
          success: false,
          message: providerMessage
            ? `Rocket.Chat 发送失败: ${providerMessage}`
            : `Rocket.Chat 返回状态码: ${response.status}`,
          latency,
        };
      }

      // v78 batch 3: Kook / Fanbook 收 { content } 而非 { text }
      case 'kook':
      case 'fanbook': {
        const response = await axios.post(
          webhook,
          { content: `${WEBHOOK_TEST_TEXT}（${type === 'kook' ? 'Kook' : 'Fanbook'} 渠道）` },
          { headers: jsonHeaders, timeout: 10000 },
        );
        const latency = Date.now() - start;
        const code = (response.data as { code?: number } | undefined)?.code;
        if (response.status >= 200 && response.status < 300 && code !== undefined && code !== 0) {
          return { success: false, message: `${type === 'kook' ? 'Kook' : 'Fanbook'} 返回错误码 ${code}`, latency };
        }
        if (response.status >= 200 && response.status < 300) {
          return { success: true, message: `${type === 'kook' ? 'Kook' : 'Fanbook'} 连接成功，请到频道确认测试消息`, latency };
        }
        return { success: false, message: `服务器返回状态码: ${response.status}`, latency };
      }

      // v2.28 batch: Webex 收 { markdown }；Notifiarr 收 { payload }
      case 'webex': {
        const response = await axios.post(
          webhook,
          { markdown: `${WEBHOOK_TEST_TEXT}（Webex 渠道）` },
          { headers: jsonHeaders, timeout: 10000 },
        );
        const latency = Date.now() - start;
        if (response.status >= 200 && response.status < 300) {
          return { success: true, message: 'Webex 连接成功，请到 Space 确认测试消息', latency };
        }
        return { success: false, message: `Webex 返回状态码: ${response.status}`, latency };
      }

      case 'notifiarr': {
        const response = await axios.post(
          webhook,
          { payload: { title: 'TimeMark 渠道测试', message: `${WEBHOOK_TEST_TEXT}（Notifiarr 渠道）` } },
          { headers: jsonHeaders, timeout: 10000 },
        );
        const latency = Date.now() - start;
        if (response.status >= 200 && response.status < 300) {
          return { success: true, message: 'Notifiarr 连接成功，请到通知目标确认测试消息', latency };
        }
        return { success: false, message: `Notifiarr 返回状态码: ${response.status}`, latency };
      }

      // v2.29 batch (wave4): Guilded 收 { content }（Discord 同构）；Awtrix 调 /api/notify
      case 'guilded': {
        const response = await axios.post(
          webhook,
          { content: `${WEBHOOK_TEST_TEXT}（Guilded 渠道）` },
          { headers: jsonHeaders, timeout: 10000 },
        );
        const latency = Date.now() - start;
        if (response.status >= 200 && response.status < 300) {
          return { success: true, message: 'Guilded 连接成功，请到频道确认测试消息', latency };
        }
        return { success: false, message: `Guilded 返回状态码: ${response.status}`, latency };
      }

      case 'awtrix': {
        const response = await axios.post(
          `${webhook.replace(/\/$/, '')}/api/notify`,
          { title: 'TimeMark', text: WEBHOOK_TEST_TEXT },
          { headers: jsonHeaders, timeout: 10000 },
        );
        const latency = Date.now() - start;
        if (response.status >= 200 && response.status < 300) {
          return { success: true, message: 'Awtrix 连接成功，请看设备屏幕确认测试消息', latency };
        }
        return { success: false, message: `Awtrix 返回状态码: ${response.status}`, latency };
      }

      case 'generic_webhook':
      default: {
        const response = await axios.post(
          webhook,
          { text },
          { headers: jsonHeaders, timeout: 10000 },
        );
        const latency = Date.now() - start;
        if (response.status >= 200 && response.status < 300) {
          return { success: true, message: 'Webhook 连接成功', latency };
        }
        return { success: false, message: `服务器返回状态码: ${response.status}`, latency };
      }
    }
  } catch (error: any) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testTokenChannel(
  type: string, 
  token: string, 
  chatId?: string,
  webhook?: string,
  secret?: string,
): Promise<TestConnectionResult> {
  // apprise may run without notification URLs (server-side default config), so token is optional there.
  if (!token && type !== 'apprise') {
    return { success: false, message: 'Token 不能为空' };
  }

  switch (type) {
    case 'email':
    case 'resend':
      return await testEmailChannel(token, webhook!, chatId!);
    
    case 'smtp':
      return await testSmtpChannel(webhook!, token, chatId!, parseInt(String(secret || '587'), 10));
    
    case 'telegram':
      return await testTelegramChannel(token, chatId!);
    
    case 'qmsg':
      return await testQmsgChannel(token, chatId!);
    
    case 'wxpusher':
      return await testWxpusherChannel(token, chatId!);
    
    case 'line':
      return await testLineChannel(token, chatId!);
    
    case 'nextcloud_talk':
      return await testNextcloudTalkChannel(webhook!, token, chatId!);
    
    case 'mattermost':
      return await testMattermostChannel(webhook!, token, chatId!);
    
    case 'matrix':
      return await testMatrixChannel(webhook!, token, chatId!);
    
    case 'msteams':
      return await testMsTeamsChannel(webhook!);
    
    case 'nostr':
      return await testNostrChannel(webhook!, token);
    
    case 'serverchan':
      return await testServerChanChannel(token);
    
    case 'pushplus':
      return await testPushPlusChannel(token, chatId);
    
    case 'bark':
      return await testBarkChannel(webhook!, token);
    
    case 'gotify':
      return await testGotifyChannel(webhook!, token);
    
    case 'meow':
      return await testMeowChannel(token);
    
    case 'pushme':
      return await testPushMeChannel(token);

    case 'pushdeer':
      return await testPushDeerChannel(token, webhook);
    
    case 'ntfy':
      return await testNtfyChannel(webhook!, token);
    
    case 'pushover':
      // B2: account.token = User Key, account.secret = App Token, account.chat_id = priority.
      // The old call passed chatId (the priority) as the application token.
      return await testPushoverChannel(token, secret!);

    case 'twilio':
      return await testTwilioChannel(token, secret!);

    case 'wecomapp':
      return await testWeComAppChannel(token, secret!);

    case 'apprise':
      return await testAppriseChannel(webhook!, token);

    // Wave 2 channels (checkboxes 15-22)
    case 'serverchan3':
      return await testServerChan3Channel(token, webhook);

    case 'xizhi':
      return await testXizhiChannel(token);

    case 'anpush':
      return await testAnPushChannel(token, chatId);

    case 'chanify':
      return await testChanifyChannel(webhook, token);

    case 'pushback':
      return await testPushbackChannel(token, chatId);

    case 'simplepush':
      return await testSimplePushChannel(token);

    case 'zulip':
      return await testZulipChannel(webhook!, token, chatId, secret);

    case 'fcm':
      return await testFcmChannel(token, chatId);

    case 'twilio_whatsapp':
      return await testTwilioWhatsAppChannel(token, secret!);

    // v78 batch 3
    case 'whatsapp_cloud':
      return await testWhatsAppCloudChannel(token, secret!, chatId!);

    case 'homeassistant':
      return await testHomeAssistantChannel(webhook!, token, chatId!);

    // v2.28 batch
    case 'pushbullet':
      return await testPushBulletChannel(token!);
    case 'join':
      return await testJoinChannel(token!, chatId!);
    case 'pushsafer':
      return await testPushSaferChannel(token!);

    // v2.29 batch (wave4)
    case 'ifttt':
      return await testIftttChannel(token!, webhook!);
    case 'revolt':
      return await testRevoltChannel(token!, chatId!);
    case 'onesignal':
      return await testOneSignalChannel(token!, secret!);
    case 'sendgrid':
      return await testSendgridChannel(token!, secret!, chatId!);
    case 'mailgun':
      return await testMailgunChannel(token!, webhook!, chatId!);
    case 'vonage_sms':
      return await testVonageSmsChannel(token!, secret!, chatId!);
    case 'messagebird':
      return await testMessagebirdChannel(token!, chatId!);
    case 'alertzy':
      return await testAlertzyChannel(token!);

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

  const start = Date.now();
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
    const latency = Date.now() - start;

    if (error) {
      return { success: false, message: `发送失败: ${error.message}`, latency };
    }

    return { success: true, message: '测试邮件已发送，请检查收件箱', latency };
  } catch (error: any) {
    const latency = Date.now() - start;
    if (error.message?.includes('Invalid API key')) {
      return { success: false, message: 'API Key 无效，请检查是否正确', latency, details: '认证信息无效，请检查 Token/API Key' };
    }
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
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

  const start = Date.now();
  try {
    const response = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`, {
      timeout: 10000
    });

    if (!response.data.ok) {
      return { success: false, message: 'Token 无效', latency: Date.now() - start };
    }

    const botInfo = response.data.result;
    
    const chatResponse = await axios.get(`https://api.telegram.org/bot${botToken}/getChat?chat_id=${chatId}`, {
      timeout: 10000
    });

    const latency = Date.now() - start;
    if (!chatResponse.data.ok) {
      return { success: false, message: 'Chat ID 无效或机器人无权限访问该聊天', latency };
    }

    return { 
      success: true, 
      message: `已连接到机器人 ${botInfo.username}`,
      latency
    };
  } catch (error: any) {
    const latency = Date.now() - start;
    if (error.response?.data?.error_code === 401) {
      return { success: false, message: 'Bot Token 无效', latency, details: '认证信息无效，请检查 Token/API Key' };
    }
    if (error.response?.data?.error_code === 400) {
      return { success: false, message: 'Chat ID 格式不正确', latency };
    }
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testQmsgChannel(key: string, qq?: string): Promise<TestConnectionResult> {
  if (!key) {
    return { success: false, message: 'Qmsg Key 不能为空' };
  }

  const start = Date.now();
  try {
    const url = qq 
      ? `https://qmsg.zendee.cn/send/${key}?qq=${qq}`
      : `https://qmsg.zendee.cn/send/${key}`;
    
    const response = await axios.post(url, {
      msg: '🔔 TimeMark 连接测试'
    }, {
      timeout: 10000
    });
    const latency = Date.now() - start;

    if (response.data.code === 0) {
      return { success: true, message: 'Qmsg 连接成功', latency };
    } else {
      return { success: false, message: `发送失败: ${response.data.text}`, latency };
    }
  } catch (error: any) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testWxpusherChannel(appToken: string, uid: string): Promise<TestConnectionResult> {
  if (!appToken || !uid) {
    return { success: false, message: 'AppToken 和 UID 都不能为空' };
  }

  const start = Date.now();
  try {
    const response = await axios.post('http://wxpusher.zjiecode.com/api/send/message', {
      appToken,
      content: '🔔 TimeMark 连接测试',
      uids: [uid]
    }, {
      timeout: 10000
    });
    const latency = Date.now() - start;

    if (response.data.code === 1000) {
      return { success: true, message: 'WxPusher 连接成功', latency };
    } else if (response.data.code === 1001) {
      return { success: false, message: 'AppToken 无效', latency, details: '认证信息无效，请检查 Token/API Key' };
    } else if (response.data.code === 1002) {
      return { success: false, message: 'UID 无效', latency };
    } else {
      return { success: false, message: `发送失败: ${response.data.msg}`, latency };
    }
  } catch (error: any) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testLineChannel(channelToken: string, userId: string): Promise<TestConnectionResult> {
  if (!channelToken || !userId) {
    return { success: false, message: 'Channel Access Token 和 User ID 都不能为空' };
  }

  const start = Date.now();
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
    const latency = Date.now() - start;

    if (response.status === 200) {
      return { success: true, message: 'LINE 连接成功', latency };
    } else {
      return { success: false, message: `HTTP ${response.status}`, latency };
    }
  } catch (error: any) {
    const latency = Date.now() - start;
    if (error.response?.status === 401) {
      return { success: false, message: 'Channel Access Token 无效', latency, details: '认证信息无效，请检查 Token/API Key' };
    }
    if (error.response?.status === 400 && error.response?.data?.message?.includes('Invalid destination')) {
      return { success: false, message: 'User ID 无效', latency };
    }
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
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

  const start = Date.now();
  try {
    const response = await axios.post(
      `https://sctapi.ftqq.com/${sendKey}.send`,
      new URLSearchParams({ title: 'TimeMark 连接测试', desp: '您的 Server酱 渠道配置正确。' }),
      { timeout: 10000 }
    );
    const latency = Date.now() - start;

    if (response.data?.code === 0) {
      return { success: true, message: 'Server酱 连接成功', latency };
    } else {
      return { success: false, message: `发送失败: ${response.data?.message || '未知错误'}`, latency };
    }
  } catch (error: any) {
    const latency = Date.now() - start;
    if (error.response?.status === 401 || error.response?.data?.code === 40001) {
      return { success: false, message: 'SendKey 无效', latency, details: '认证信息无效，请检查 Token/API Key' };
    }
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testPushPlusChannel(token: string, topic?: string): Promise<TestConnectionResult> {
  if (!token) {
    return { success: false, message: 'Token 不能为空' };
  }

  const start = Date.now();
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
    const latency = Date.now() - start;

    if (response.data?.code === 200) {
      return { success: true, message: 'PushPlus 连接成功', latency };
    } else {
      return { success: false, message: `发送失败: ${response.data?.msg || '未知错误'}`, latency };
    }
  } catch (error: any) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testBarkChannel(serverUrl: string, deviceKey: string): Promise<TestConnectionResult> {
  if (!serverUrl || !deviceKey) {
    return { success: false, message: '服务器地址和设备密钥不能为空' };
  }

  const start = Date.now();
  try {
    const baseUrl = serverUrl.replace(/\/+$/, '');
    const response = await axios.get(
      `${baseUrl}/${encodeURIComponent(deviceKey)}/TimeMark+连接测试/渠道配置正确`,
      { timeout: 10000 }
    );
    const latency = Date.now() - start;

    if (response.data?.code === 200) {
      return { success: true, message: 'Bark 连接成功', latency };
    } else {
      return { success: false, message: `发送失败: ${response.data?.message || '未知错误'}`, latency };
    }
  } catch (error: any) {
    const latency = Date.now() - start;
    if (error.response?.status === 400) {
      return { success: false, message: '设备密钥无效', latency };
    }
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testGotifyChannel(serverUrl: string, appToken: string): Promise<TestConnectionResult> {
  if (!serverUrl || !appToken) {
    return { success: false, message: '服务器地址和 App Token 不能为空' };
  }

  const start = Date.now();
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
    const latency = Date.now() - start;

    if (response.status >= 200 && response.status < 300) {
      return { success: true, message: 'Gotify 连接成功', latency };
    } else {
      return { success: false, message: `服务器返回状态码: ${response.status}`, latency };
    }
  } catch (error: any) {
    const latency = Date.now() - start;
    if (error.response?.status === 401) {
      return { success: false, message: 'App Token 无效', latency, details: '认证信息无效，请检查 Token/API Key' };
    }
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testMeowChannel(pushKey: string): Promise<TestConnectionResult> {
  if (!pushKey) {
    return { success: false, message: 'Push Key 不能为空' };
  }

  const start = Date.now();
  try {
    const response = await axios.get(
      `https://api.day.app/${encodeURIComponent(pushKey)}/TimeMark+连接测试/渠道配置正确`,
      { timeout: 10000 }
    );
    const latency = Date.now() - start;

    if (response.data?.code === 200) {
      return { success: true, message: 'Meow 连接成功', latency };
    } else {
      return { success: false, message: `发送失败: ${response.data?.message || '未知错误'}`, latency };
    }
  } catch (error: any) {
    const latency = Date.now() - start;
    if (error.response?.status === 400) {
      return { success: false, message: 'Push Key 无效', latency };
    }
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testPushMeChannel(pushKey: string): Promise<TestConnectionResult> {
  if (!pushKey) {
    return { success: false, message: 'Push Key 不能为空' };
  }

  const start = Date.now();
  try {
    const response = await axios.post(
      'https://push.i-i.me/',
      new URLSearchParams({ push_key: pushKey, title: 'TimeMark 连接测试', content: '您的 PushMe 渠道配置正确。' }),
      { timeout: 10000 }
    );
    const latency = Date.now() - start;

    if (response.data?.code === 200 || response.data?.success === true) {
      return { success: true, message: 'PushMe 连接成功', latency };
    } else {
      return { success: false, message: `发送失败: ${response.data?.msg || response.data?.message || '未知错误'}`, latency };
    }
  } catch (error: any) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testPushDeerChannel(pushKey: string, serverUrl?: string): Promise<TestConnectionResult> {
  if (!pushKey) {
    return { success: false, message: 'PushKey 不能为空' };
  }

  const base = (serverUrl || 'https://api2.pushdeer.com').replace(/\/$/, '');
  const start = Date.now();
  try {
    const response = await axios.post(
      `${base}/message/push`,
      new URLSearchParams({ pushkey: pushKey, text: 'TimeMark 连接测试：PushDeer 渠道配置正确。', type: 'text' }),
      { timeout: 10000 },
    );
    const latency = Date.now() - start;
    if (response.data?.code === 0 || !response.data?.error) {
      return { success: true, message: 'PushDeer 连接成功', latency };
    }
    return { success: false, message: `发送失败: ${response.data?.error || '未知错误'}`, latency };
  } catch (error: any) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testNtfyChannel(serverUrl: string, topic: string): Promise<TestConnectionResult> {
  if (!serverUrl || !topic) {
    return { success: false, message: '服务器地址和 Topic 不能为空' };
  }

  const start = Date.now();
  try {
    const baseUrl = serverUrl.replace(/\/+$/, '');
    // JSON publish：标题走 JSON 体，中文事件名不再进 HTTP 头（ntfy 对非 ASCII 头返回 400）
    const response = await axios.post(
      `${baseUrl}/`,
      {
        topic,
        title: 'TimeMark Test',
        message: 'TimeMark 连接测试 - 渠道配置正确',
        priority: 3,
      },
      { timeout: 10000 }
    );
    const latency = Date.now() - start;

    if (response.status >= 200 && response.status < 300) {
      return { success: true, message: 'Ntfy 连接成功', latency };
    } else {
      return { success: false, message: `服务器返回状态码: ${response.status}`, latency };
    }
  } catch (error: any) {
    const latency = Date.now() - start;
    if (error.response?.status === 401 || error.response?.status === 403) {
      return { success: false, message: '认证失败，请检查 Topic 权限', latency, details: '认证信息无效，请检查 Token/API Key' };
    }
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testPushoverChannel(userKey: string, appToken: string): Promise<TestConnectionResult> {
  if (!userKey || !appToken) {
    return { success: false, message: 'User Key 和 App Token 不能为空' };
  }

  const start = Date.now();
  try {
    const response = await axios.post(
      'https://api.pushover.net/1/users/validate.json',
      new URLSearchParams({ token: appToken, user: userKey }),
      { timeout: 10000 }
    );
    const latency = Date.now() - start;

    if (response.data?.status === 1) {
      return { success: true, message: 'Pushover 连接成功', latency };
    } else {
      return { success: false, message: `验证失败: ${response.data?.errors?.join(', ') || '未知错误'}`, latency };
    }
  } catch (error: any) {
    const latency = Date.now() - start;
    if (error.response?.status === 401) {
      return { success: false, message: 'App Token 无效', latency, details: '认证信息无效，请检查 Token/API Key' };
    }
    if (error.response?.data?.errors) {
      return { success: false, message: `验证失败: ${error.response.data.errors.join(', ')}`, latency };
    }
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

/**
 * B3: twilio was untestable. Validate the Account SID/Auth Token with HTTP Basic auth
 * against the account resource — never send a (billable) SMS from a health check.
 */
async function testTwilioChannel(accountSid: string, authToken: string): Promise<TestConnectionResult> {
  if (!accountSid || !authToken) {
    return { success: false, message: 'Account SID 和 Auth Token 都不能为空' };
  }

  const start = Date.now();
  try {
    const response = await axios.get(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`,
      { auth: { username: accountSid, password: authToken }, timeout: 10000 },
    );
    const latency = Date.now() - start;

    if (response.data?.sid) {
      return {
        success: true,
        message: `Twilio 连接成功 (${response.data.friendly_name || response.data.sid})`,
        latency,
      };
    }
    return { success: false, message: `Twilio 返回了无法识别的响应 (HTTP ${response.status})`, latency };
  } catch (error: any) {
    const latency = Date.now() - start;
    if (error.response?.status === 401 || error.response?.status === 403) {
      const providerMessage = error.response?.data?.message;
      return {
        success: false,
        message: providerMessage ? `认证失败: ${providerMessage}` : `认证失败 (HTTP ${error.response.status})`,
        latency,
        details: '认证信息无效，请检查 Token/API Key',
      };
    }
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

/**
 * B3: wecomapp was untestable. `gettoken` is a read-only credential check — it never sends a message.
 */
async function testWeComAppChannel(corpid: string, corpsecret: string): Promise<TestConnectionResult> {
  if (!corpid || !corpsecret) {
    return { success: false, message: 'CorpID 和 CorpSecret 都不能为空' };
  }

  const start = Date.now();
  try {
    const response = await axios.get(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpid)}&corpsecret=${encodeURIComponent(corpsecret)}`,
      { timeout: 10000 },
    );
    const latency = Date.now() - start;
    const data = response.data;

    if (data?.errcode === 0) {
      return { success: true, message: '企微应用 连接成功', latency };
    }
    if (typeof data?.errcode === 'number') {
      return {
        success: false,
        message: `认证失败: ${data.errmsg || `errcode ${data.errcode}`}`,
        latency,
        details: '认证信息无效，请检查 CorpID/CorpSecret',
      };
    }
    return { success: false, message: `企微应用返回了无法识别的响应 (HTTP ${response.status})`, latency };
  } catch (error: any) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

/**
 * B3: apprise was untestable. With notification URLs configured, POST {server}/notify and
 * assert the JSON `success` field; without them, probe GET {server}/status (sends nothing).
 */
async function testAppriseChannel(serverUrl: string, urls?: string): Promise<TestConnectionResult> {
  if (!serverUrl) {
    return { success: false, message: 'Apprise 服务器地址不能为空' };
  }

  const baseUrl = serverUrl.replace(/\/+$/, '');
  const start = Date.now();
  try {
    if (urls?.trim()) {
      const response = await axios.post(
        `${baseUrl}/notify`,
        {
          title: 'TimeMark 连接测试',
          body: '您的 Apprise 渠道配置正确。',
          type: 'info',
          urls: urls.trim(),
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
      );
      const latency = Date.now() - start;
      const data = response.data;

      if (data?.success === true) {
        return { success: true, message: 'Apprise 连接成功', latency };
      }
      if (data?.success === false) {
        return {
          success: false,
          message: `发送失败: ${data.error || data.message || '未知错误'}`,
          latency,
        };
      }
      return { success: false, message: `Apprise 返回了无法识别的响应 (HTTP ${response.status})`, latency };
    }

    // No notification URLs configured: probe the server status instead of sending anything.
    const response = await axios.get(`${baseUrl}/status`, { timeout: 10000 });
    const latency = Date.now() - start;
    const data = response.data;
    if (data?.success === true || (typeof data?.status === 'string' && data.status.length > 0)) {
      return { success: true, message: 'Apprise 服务器可用', latency };
    }
    return { success: false, message: `Apprise 返回了无法识别的响应 (HTTP ${response.status})`, latency };
  } catch (error: any) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testMatrixChannel(serverUrl: string, accessToken: string, roomId: string): Promise<TestConnectionResult> {
  if (!serverUrl) {
    return { success: false, message: 'Matrix 服务器地址不能为空' };
  }
  if (!accessToken) {
    return { success: false, message: 'Access Token 不能为空' };
  }
  if (!roomId) {
    return { success: false, message: 'Room ID 不能为空' };
  }

  const baseUrl = serverUrl.replace(/\/+$/, '');
  const start = Date.now();

  try {
    // Test server reachability by hitting the login endpoint
    const response = await axios.post(
      `${baseUrl}/_matrix/client/v3/login`,
      {},
      { timeout: 10000, validateStatus: () => true }
    );
    const latency = Date.now() - start;

    // 401 or 400 means server is reachable (auth required)
    if (response.status === 401 || response.status === 400 || response.status === 403) {
      // Now verify the access token by checking whoami
      try {
        const whoami = await axios.get(`${baseUrl}/_matrix/client/v3/account/whoami`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10000,
        });
        const totalLatency = Date.now() - start;
        if (whoami.status === 200) {
          return { success: true, message: `Matrix 连接成功 (${whoami.data.user_id})`, latency: totalLatency };
        }
      } catch (tokenErr: any) {
        const totalLatency = Date.now() - start;
        if (tokenErr.response?.status === 401) {
          return { success: false, message: 'Access Token 无效', latency: totalLatency, details: '认证信息无效，请检查 Token/API Key' };
        }
        return { success: false, message: `Token 验证失败: ${tokenErr.message}`, latency: totalLatency };
      }
    }

    if (response.status === 404) {
      return { success: false, message: 'Matrix API 端点未找到', latency, details: '服务器地址可能不正确，请确认是 Matrix homeserver 地址' };
    }

    return { success: true, message: 'Matrix 服务器可达', latency };
  } catch (error: any) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testMattermostChannel(serverUrl: string, token: string, channelId: string): Promise<TestConnectionResult> {
  if (!serverUrl) {
    return { success: false, message: 'Mattermost 服务器地址不能为空' };
  }
  if (!token) {
    return { success: false, message: 'Token 不能为空' };
  }
  if (!channelId) {
    return { success: false, message: 'Channel ID 不能为空' };
  }

  const baseUrl = serverUrl.replace(/\/+$/, '');
  const start = Date.now();

  try {
    // Test server reachability with ping endpoint
    const pingResponse = await axios.get(`${baseUrl}/api/v4/system/ping`, {
      timeout: 10000,
    });
    const latency = Date.now() - start;

    if (pingResponse.status === 200) {
      // Verify token by getting current user
      try {
        const meResponse = await axios.get(`${baseUrl}/api/v4/users/me`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000,
        });
        const totalLatency = Date.now() - start;
        if (meResponse.status === 200) {
          return { success: true, message: `Mattermost 连接成功 (${meResponse.data.username})`, latency: totalLatency };
        }
      } catch (tokenErr: any) {
        const totalLatency = Date.now() - start;
        if (tokenErr.response?.status === 401) {
          return { success: false, message: 'Token 无效', latency: totalLatency, details: '认证信息无效，请检查 Token/API Key' };
        }
        return { success: false, message: `Token 验证失败: ${tokenErr.message}`, latency: totalLatency };
      }
    }

    return { success: false, message: `服务器返回状态码: ${pingResponse.status}`, latency };
  } catch (error: any) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testNextcloudTalkChannel(serverUrl: string, token: string, roomToken: string): Promise<TestConnectionResult> {
  if (!serverUrl) {
    return { success: false, message: 'Nextcloud 服务器地址不能为空' };
  }
  if (!token) {
    return { success: false, message: 'Token 不能为空' };
  }
  if (!roomToken) {
    return { success: false, message: 'Room Token 不能为空' };
  }

  const baseUrl = serverUrl.replace(/\/+$/, '');
  const start = Date.now();

  try {
    // Test server reachability via Talk API
    const response = await axios.get(
      `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/room`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'OCS-APIRequest': 'true',
          'Accept': 'application/json',
        },
        timeout: 10000,
        validateStatus: () => true,
      }
    );
    const latency = Date.now() - start;

    if (response.status === 200) {
      return { success: true, message: 'Nextcloud Talk 连接成功', latency };
    }
    if (response.status === 401) {
      // Server is reachable but auth failed - check if it's basic auth
      // Try with basic auth (username:token format)
      return { success: false, message: '认证失败', latency, details: '认证信息无效，请检查 Token/API Key' };
    }
    if (response.status === 404) {
      return { success: false, message: 'Talk 应用未找到', latency, details: '请确认 Nextcloud 已安装 Talk 应用' };
    }

    return { success: false, message: `服务器返回状态码: ${response.status}`, latency };
  } catch (error: any) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testMsTeamsChannel(webhookUrl: string): Promise<TestConnectionResult> {
  if (!webhookUrl) {
    return { success: false, message: 'Webhook URL 不能为空' };
  }

  const start = Date.now();

  try {
    // Send an empty adaptive card to test connectivity
    // MS Teams webhooks return 400 for invalid payload but that proves connectivity
    const response = await axios.post(
      webhookUrl,
      { type: 'message', text: '' },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
        validateStatus: () => true,
      }
    );
    const latency = Date.now() - start;

    // 200 = sent successfully, 400 = bad payload but server reachable
    if (response.status === 200 || response.status === 202) {
      return { success: true, message: 'MS Teams Webhook 连接成功', latency };
    }
    if (response.status === 400) {
      // 400 means the webhook endpoint is reachable
      return { success: true, message: 'MS Teams Webhook 可达', latency };
    }
    if (response.status === 404) {
      return { success: false, message: 'Webhook URL 无效或已过期', latency, details: '服务器地址可能不正确' };
    }
    if (response.status === 429) {
      return { success: true, message: 'MS Teams Webhook 可达（请求频率受限）', latency };
    }

    return { success: false, message: `服务器返回状态码: ${response.status}`, latency };
  } catch (error: any) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testNostrChannel(relayUrl: string, privateKey: string): Promise<TestConnectionResult> {
  if (!relayUrl) {
    return { success: false, message: 'Relay URL 不能为空' };
  }
  if (!privateKey) {
    return { success: false, message: '私钥不能为空' };
  }

  const start = Date.now();

  try {
    // Test relay reachability via HTTP GET (most relays respond to HTTP)
    // Convert wss:// to https:// for HTTP probe
    const httpUrl = relayUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
    const response = await axios.get(httpUrl, {
      timeout: 10000,
      headers: { Accept: 'text/html,application/json' },
      validateStatus: () => true,
    });
    const latency = Date.now() - start;

    // Any response means the relay is reachable
    if (response.status >= 200 && response.status < 500) {
      return { success: true, message: 'Nostr Relay 可达', latency };
    }

    return { success: false, message: `Relay 返回状态码: ${response.status}`, latency };
  } catch (error: any) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

async function testSmtpChannel(
  smtpHost: string,
  password: string,
  fromEmail: string,
  port = 587,
): Promise<TestConnectionResult> {
  if (!smtpHost || !password || !fromEmail) {
    return { success: false, message: 'SMTP 服务器、授权码和发件邮箱都不能为空' };
  }

  const start = Date.now();
  try {
    const { createSmtpTransporter } = await import('../../utils/smtp-transporter.js');
    const transporter = createSmtpTransporter(smtpHost, port, fromEmail, password);

    let verified = false;
    try {
      await transporter.verify();
      verified = true;
    } catch {
      // 部分邮箱（如 163）对 verify 响应不佳，改发一封自测邮件
      await transporter.sendMail({
        from: fromEmail,
        to: fromEmail,
        subject: 'TimeMark SMTP 连接测试',
        text: '这是一封 TimeMark SMTP 连接测试邮件。收到即表示配置正确。',
      });
      verified = true;
    }

    if (verified) {
      const latency = Date.now() - start;
      return { success: true, message: `SMTP 连接成功（${smtpHost}:${port}）`, latency };
    }
    return { success: false, message: 'SMTP 连接失败' };
  } catch (error: any) {
    const latency = Date.now() - start;
    if (error.code === 'EAUTH') {
      return {
        success: false,
        message: 'SMTP 认证失败：请确认使用客户端授权码（不是登录密码），且发件人邮箱填写完整',
        latency,
        details: error.response || error.message,
      };
    }
    if (error.code === 'ECONNREFUSED') {
      return { success: false, message: 'SMTP 服务器连接被拒绝，请检查服务器地址和端口', latency };
    }
    if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKET') {
      return {
        success: false,
        message: 'SMTP 连接超时：云服务器 IP 可能被邮箱服务商限制，可尝试 STARTTLS(587) 或改用 Resend',
        latency,
        details: error.message,
      };
    }
    const hostLower = smtpHost.toLowerCase();
    if (hostLower.includes('163.com') || hostLower.includes('126.com') || hostLower.includes('qq.com')) {
      return {
        success: false,
        message: `SMTP 连接失败: ${error.message}。网易/QQ 邮箱需使用授权码，且可能限制云服务器 IP`,
        latency,
        details: '可在配置中切换 SSL(465) / STARTTLS(587) 后重试',
      };
    }
    return { success: false, message: `SMTP 连接失败: ${error.message}`, latency };
  }
}

/** Narrow thrown values without the legacy `error: any` (keeps lint at the pre-wave warning count). */
function thrownMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function httpStatusOf(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | undefined)?.response?.status;
}

function providerMessageOf(error: unknown): string | undefined {
  return (error as { response?: { data?: { message?: string } } } | undefined)?.response?.data?.message;
}

/**
 * Checkbox 15: Server酱³ (SC3). The uid is taken from the account UID field or derived from the
 * `sctp<uid>t...` key; a key with no derivable uid fails BEFORE any request is made.
 * Success is the provider's own `code === 0` (never a bare HTTP 2xx).
 */
async function testServerChan3Channel(sendKey: string, uidOverride?: string): Promise<TestConnectionResult> {
  let url: string;
  try {
    url = buildServerChan3Url(sendKey, uidOverride);
  } catch (error) {
    return { success: false, message: thrownMessage(error, '无法推导 SC3 UID') };
  }

  const start = Date.now();
  try {
    const response = await axios.post(
      url,
      new URLSearchParams({ title: 'TimeMark 连接测试', desp: '您的 Server酱³ 渠道配置正确。' }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 },
    );
    const latency = Date.now() - start;
    if (response.data?.code === 0) {
      return { success: true, message: 'Server酱³ 连接成功', latency };
    }
    // Live fixture shape: HTTP 200 {"error":"sendkey not found","code":10003} — surface it.
    const providerMessage = response.data?.error || response.data?.message || response.data?.msg;
    return { success: false, message: `发送失败: ${providerMessage || '未知错误'}`, latency };
  } catch (error) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

/**
 * Checkbox 16: 息知. Live-probed 2026-09-27: success is `{"code":200}` with HTTP 200;
 * an invalid key returns `{"code":10000,"msg":"..."}` — also with HTTP 200.
 */
async function testXizhiChannel(key: string): Promise<TestConnectionResult> {
  const start = Date.now();
  try {
    const response = await axios.post(
      buildXizhiUrl(key),
      new URLSearchParams({ title: 'TimeMark 连接测试', content: '您的息知渠道配置正确。' }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 },
    );
    const latency = Date.now() - start;
    if (response.data?.code === 200) {
      return { success: true, message: '息知 连接成功', latency };
    }
    return { success: false, message: `发送失败: ${response.data?.msg || response.data?.message || '未知错误'}`, latency };
  } catch (error) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

/** Checkbox 17: AnPush — success is the provider's `code === 200` in the JSON body. */
async function testAnPushChannel(token: string, channel?: string): Promise<TestConnectionResult> {
  const start = Date.now();
  try {
    const params = new URLSearchParams({ title: 'TimeMark 连接测试', content: '您的 AnPush 渠道配置正确。' });
    if (channel) params.set('channel', channel);
    const response = await axios.post(buildAnPushUrl(token), params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    const latency = Date.now() - start;
    if (response.data?.code === 200) {
      return { success: true, message: 'AnPush 连接成功', latency };
    }
    return { success: false, message: `发送失败: ${response.data?.msg || response.data?.message || '未知错误'}`, latency };
  } catch (error) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

/**
 * Checkbox 18: Chanify. Success is HTTP 2xx; a base URL containing a path is rejected as a
 * configuration error (no /v1/v1 request), matching the service-side validation.
 */
async function testChanifyChannel(baseUrl: string | undefined, token: string): Promise<TestConnectionResult> {
  let base: string;
  try {
    base = normalizeChanifyBaseUrl(baseUrl);
  } catch (error) {
    return { success: false, message: thrownMessage(error, 'Chanify 服务器地址无效') };
  }

  const start = Date.now();
  try {
    const url = `${base}/v1/sender/${encodeURIComponent(token)}?title=${encodeURIComponent('TimeMark 连接测试')}&sound=1`;
    const response = await axios.post(url, new URLSearchParams({ text: '您的 Chanify 渠道配置正确。' }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    const latency = Date.now() - start;
    if (response.status >= 200 && response.status < 300) {
      return { success: true, message: 'Chanify 连接成功', latency };
    }
    return { success: false, message: `服务器返回状态码: ${response.status}`, latency };
  } catch (error) {
    const latency = Date.now() - start;
    const status = httpStatusOf(error);
    if (status === 401 || status === 403) {
      return { success: false, message: 'Chanify Token 无效', latency, details: '认证信息无效，请检查 Token/API Key' };
    }
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

/**
 * Checkbox 19: Pushback. Official examples use Bearer + JSON; external SDKs validate the response
 * body (`0` or a status field), so a non-confirming body is reported as an unrecognized response
 * instead of a false success.
 */
async function testPushbackChannel(token: string, userId?: string): Promise<TestConnectionResult> {
  if (!userId) {
    return { success: false, message: 'User ID 不能为空' };
  }

  const start = Date.now();
  try {
    const response = await axios.post(
      'https://api.pushback.io/v1/send',
      { id: userId, title: 'TimeMark 连接测试', body: '您的 Pushback 渠道配置正确。' },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 },
    );
    const latency = Date.now() - start;
    if (isPushbackSuccess(response.data)) {
      return { success: true, message: 'Pushback 连接成功', latency };
    }
    const providerMessage = (response.data as { message?: string } | null)?.message;
    return {
      success: false,
      message: providerMessage ? `发送失败: ${providerMessage}` : `Pushback 返回了无法识别的响应 (HTTP ${response.status})`,
      latency,
    };
  } catch (error) {
    const latency = Date.now() - start;
    const status = httpStatusOf(error);
    if (status === 401 || status === 403) {
      return {
        success: false,
        message: `Pushback Access Token 无效 (HTTP ${status})`,
        latency,
        details: '认证信息无效，请检查 Token/API Key',
      };
    }
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

/** Checkbox 19: SimplePush — success is the provider's `status === 'OK'` (live-probed). */
async function testSimplePushChannel(key: string): Promise<TestConnectionResult> {
  const start = Date.now();
  try {
    const response = await axios.post(
      SIMPLEPUSH_ENDPOINT,
      new URLSearchParams({ key, msg: '您的 SimplePush 渠道配置正确。', title: 'TimeMark 连接测试' }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 },
    );
    const latency = Date.now() - start;
    if (response.data?.status === 'OK') {
      return { success: true, message: 'SimplePush 连接成功', latency };
    }
    return { success: false, message: `发送失败: ${response.data?.message || response.data?.status || '未知错误'}`, latency };
  } catch (error) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

/**
 * Checkbox 20: Zulip. Basic `base64(botEmail:apiKey)` + stream form params; success is the
 * provider's `result === 'success'`. A path-bearing org URL is rejected before any request.
 */
async function testZulipChannel(
  orgUrl: string,
  apiKey: string,
  botEmail?: string,
  stream?: string,
): Promise<TestConnectionResult> {
  if (!botEmail || !stream) {
    return { success: false, message: 'Bot 邮箱和 Stream 名称不能为空' };
  }
  let org: string;
  try {
    org = normalizeZulipOrgUrl(orgUrl);
  } catch (error) {
    return { success: false, message: thrownMessage(error, 'Zulip 组织地址无效') };
  }

  const start = Date.now();
  try {
    const response = await axios.post(
      `${org}/api/v1/messages`,
      new URLSearchParams({
        type: 'stream',
        to: stream,
        topic: 'TimeMark 连接测试',
        content: '您的 Zulip 渠道配置正确。',
      }),
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${botEmail}:${apiKey}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      },
    );
    const latency = Date.now() - start;
    if (response.data?.result === 'success') {
      return { success: true, message: 'Zulip 连接成功', latency };
    }
    return { success: false, message: `发送失败: ${response.data?.msg || '未知错误'}`, latency };
  } catch (error) {
    const latency = Date.now() - start;
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

/**
 * Checkbox 21: FCM HTTP v1. The connection test ALWAYS uses `validate_only: true` (no real
 * delivery) and never logs the service-account JSON or the bearer token.
 */
async function testFcmChannel(serviceAccountJson: string, target?: string): Promise<TestConnectionResult> {
  if (!serviceAccountJson || !target) {
    return { success: false, message: '服务账号 JSON 和设备令牌/topic 不能为空' };
  }

  const start = Date.now();
  try {
    await sendFcmMessage(
      serviceAccountJson,
      target,
      { title: 'TimeMark 连接测试', body: '您的 FCM 渠道配置正确。' },
      { validateOnly: true },
    );
    return { success: true, message: 'FCM 连接成功（validate_only 校验通过，未真实下发）', latency: Date.now() - start };
  } catch (error) {
    return { success: false, message: thrownMessage(error, 'FCM 连接失败'), latency: Date.now() - start };
  }
}

/**
 * Checkbox 22: Twilio WhatsApp. Same credential validation as `twilio` (GET the account resource);
 * the health check never sends a billable WhatsApp message.
 */
async function testTwilioWhatsAppChannel(accountSid: string, authToken: string): Promise<TestConnectionResult> {
  if (!accountSid || !authToken) {
    return { success: false, message: 'Account SID 和 Auth Token 都不能为空' };
  }

  const start = Date.now();
  try {
    const response = await axios.get(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`,
      { auth: { username: accountSid, password: authToken }, timeout: 10000 },
    );
    const latency = Date.now() - start;
    if (response.data?.sid) {
      return {
        success: true,
        message: `Twilio WhatsApp 连接成功 (${response.data.friendly_name || response.data.sid})`,
        latency,
      };
    }
    return { success: false, message: `Twilio WhatsApp 返回了无法识别的响应 (HTTP ${response.status})`, latency };
  } catch (error) {
    const latency = Date.now() - start;
    const status = httpStatusOf(error);
    if (status === 401 || status === 403) {
      const providerMessage = providerMessageOf(error);
      return {
        success: false,
        message: providerMessage ? `认证失败: ${providerMessage}` : `认证失败 (HTTP ${status})`,
        latency,
        details: '认证信息无效，请检查 Token/API Key',
      };
    }
    const diag = diagnoseError(error);
    return { success: false, message: diag.message, latency, details: diag.details };
  }
}

