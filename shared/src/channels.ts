/**
 * 通知渠道配置定义
 * 定义每个渠道的配置方式、图标、描述等信息
 */

export type ConfigMethod = 'webhook' | 'token' | 'plugin';

export interface ChannelDefinition {
  id: string;
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  icon: string;
  configMethod: ConfigMethod;
  // 配置字段
  configFields: ConfigField[];
  // 需要的npm包（仅插件渠道）
  pluginPackage?: string;
  // 文档链接
  docUrl?: string;
  // 官方集成页面
  officialUrl?: string;
  // 是否是bundled（内置）
  bundled?: boolean;
}

export interface ConfigField {
  key: string;
  label: string;
  labelEn: string;
  placeholder: string;
  placeholderEn: string;
  type: 'text' | 'password' | 'textarea';
  required: boolean;
  helpText?: string;
}

// 渠道分类
export const channelCategories = {
  // 即时通讯
  im: {
    name: '即时通讯',
    nameEn: 'Instant Messaging',
  },
  // 邮件
  email: {
    name: '邮件',
    nameEn: 'Email',
  },
  // Webhook
  webhook: {
    name: 'Webhook',
    nameEn: 'Webhook',
  },
  // 插件（需要npm包）
  plugin: {
    name: '插件渠道',
    nameEn: 'Plugin Channels',
  },
} as const;

// 所有渠道定义
export const channels: ChannelDefinition[] = [
  // ============ 邮件渠道 ============
  {
    id: 'resend',
    name: 'Resend',
    nameEn: 'Resend',
    description: 'Resend 邮件 API 推送，支持HTML格式',
    descriptionEn: 'Send event reminders via Resend email API with HTML formatting',
    icon: 'mail',
    configMethod: 'token',
    configFields: [
      {
        key: 'apiKey',
        label: 'Resend API Key',
        labelEn: 'Resend API Key',
        placeholder: 're_xxxxxx',
        placeholderEn: 're_xxxxxx',
        type: 'password',
        required: true,
        helpText: '从 https://resend.com 获取 API Key',
      },
      {
        key: 'emails',
        label: '收件人邮箱',
        labelEn: 'Recipient Emails',
        placeholder: 'user@example.com',
        placeholderEn: 'user@example.com',
        type: 'textarea',
        required: true,
        helpText: '多个邮箱用逗号分隔',
      },
    ],
    bundled: true,
  },
  {
    id: 'smtp',
    name: 'SMTP 邮件',
    nameEn: 'SMTP Email',
    description: 'SMTP 协议邮件推送（支持 Gmail、Outlook、自建邮箱等）',
    descriptionEn: 'Send emails via SMTP protocol (Gmail, Outlook, self-hosted, etc.)',
    icon: 'mail',
    configMethod: 'token',
    configFields: [
      {
        key: 'smtpHost',
        label: 'SMTP 服务器',
        labelEn: 'SMTP Server',
        placeholder: 'smtp.gmail.com',
        placeholderEn: 'smtp.gmail.com',
        type: 'text',
        required: true,
        helpText: 'SMTP 服务器地址',
      },
      {
        key: 'smtpPort',
        label: 'SMTP 端口',
        labelEn: 'SMTP Port',
        placeholder: '587',
        placeholderEn: '587',
        type: 'text',
        required: true,
        helpText: '通常 587 (TLS) 或 465 (SSL)',
      },
      {
        key: 'password',
        label: '邮箱密码/授权码',
        labelEn: 'Password / App Password',
        placeholder: '',
        placeholderEn: '',
        type: 'password',
        required: true,
        helpText: '邮箱密码或应用专用密码/授权码',
      },
      {
        key: 'fromEmail',
        label: '发件人邮箱',
        labelEn: 'From Email',
        placeholder: 'user@gmail.com',
        placeholderEn: 'user@gmail.com',
        type: 'text',
        required: true,
        helpText: '发件人邮箱地址（也用作 SMTP 用户名）',
      },
    ],
    docUrl: 'https://nodemailer.com/about/',
    bundled: true,
  },

  // ============ Webhook 渠道 ============
  {
    id: 'discord',
    name: 'Discord',
    nameEn: 'Discord',
    description: '向 Discord 频道发送富文本消息',
    descriptionEn: 'Send rich text messages to Discord channels',
    icon: 'discord',
    configMethod: 'webhook',
    configFields: [
      {
        key: 'webhook',
        label: 'Webhook URL',
        labelEn: 'Webhook URL',
        placeholder: 'https://discord.com/api/webhooks/...',
        placeholderEn: 'https://discord.com/api/webhooks/...',
        type: 'text',
        required: true,
        helpText: '在 Discord 服务器设置中创建 webhook',
      },
    ],
    officialUrl: 'https://discord.com/developers/applications',
    bundled: true,
  },
  {
    id: 'slack',
    name: 'Slack',
    nameEn: 'Slack',
    description: '向 Slack 频道发送消息，支持 Blocks 格式',
    descriptionEn: 'Send messages to Slack channels with Blocks format',
    icon: 'slack',
    configMethod: 'webhook',
    configFields: [
      {
        key: 'webhook',
        label: 'Webhook URL',
        labelEn: 'Webhook URL',
        placeholder: 'https://hooks.slack.com/services/...',
        placeholderEn: 'https://hooks.slack.com/services/...',
        type: 'text',
        required: true,
        helpText: '在 Slack 应用设置中创建 Incoming Webhook',
      },
    ],
    officialUrl: 'https://api.slack.com/messaging/webhooks',
    bundled: true,
  },
  {
    id: 'feishu',
    name: '飞书',
    nameEn: 'Feishu',
    description: '向飞书群聊发送卡片消息',
    descriptionEn: 'Send card messages to Feishu group chats',
    icon: 'feishu',
    configMethod: 'webhook',
    configFields: [
      {
        key: 'webhook',
        label: 'Webhook URL',
        labelEn: 'Webhook URL',
        placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...',
        placeholderEn: 'https://open.feishu.cn/open-apis/bot/v2/hook/...',
        type: 'text',
        required: true,
        helpText: '在飞书群聊中添加自定义机器人获取',
      },
    ],
    officialUrl: 'https://open.feishu.cn/document/ukTMukTMukTM/ucTM5YjL3ETO24yNxkjN',
    bundled: true,
  },
  {
    id: 'wecom',
    name: '企业微信',
    nameEn: 'WeCom',
    description: '向企业微信群聊发送 Markdown 消息',
    descriptionEn: 'Send Markdown messages to WeCom group chats',
    icon: 'wecom',
    configMethod: 'webhook',
    configFields: [
      {
        key: 'webhook',
        label: 'Webhook URL',
        labelEn: 'Webhook URL',
        placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...',
        placeholderEn: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...',
        type: 'text',
        required: true,
        helpText: '在企业微信中创建群机器人获取 webhook',
      },
    ],
    officialUrl: 'https://developer.work.weixin.qq.com/document/镇区/自定义机器人消息推送',
    bundled: true,
  },
  {
    id: 'dingtalk',
    name: '钉钉',
    nameEn: 'DingTalk',
    description: '向钉钉群聊发送消息，需要 HMAC-SHA256 签名',
    descriptionEn: 'Send messages to DingTalk group chats with HMAC-SHA256 signature',
    icon: 'dingtalk',
    configMethod: 'webhook',
    configFields: [
      {
        key: 'webhook',
        label: 'Webhook URL',
        labelEn: 'Webhook URL',
        placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...',
        placeholderEn: 'https://oapi.dingtalk.com/robot/send?access_token=...',
        type: 'text',
        required: true,
      },
      {
        key: 'secret',
        label: '签名密钥',
        labelEn: 'Signing Secret',
        placeholder: 'SEC...',
        placeholderEn: 'SEC...',
        type: 'password',
        required: true,
        helpText: '在钉钉机器人安全设置中启用签名密钥',
      },
    ],
    officialUrl: 'https://open.dingtalk.com/document/robot/customize-bot-notification',
    bundled: true,
  },
  {
    id: 'googlechat',
    name: 'Google Chat',
    nameEn: 'Google Chat',
    description: '向 Google Chat 空间发送消息',
    descriptionEn: 'Send messages to Google Chat spaces',
    icon: 'google',
    configMethod: 'webhook',
    configFields: [
      {
        key: 'webhook',
        label: 'Webhook URL',
        labelEn: 'Webhook URL',
        placeholder: 'https://chat.googleapis.com/...',
        placeholderEn: 'https://chat.googleapis.com/...',
        type: 'text',
        required: true,
        helpText: '在 Google Chat API 中创建 webhook',
      },
    ],
    officialUrl: 'https://developers.google.com/chat',
    bundled: false,
  },
  {
    id: 'telegram',
    name: 'Telegram',
    nameEn: 'Telegram',
    description: '通过 Telegram 机器人发送消息',
    descriptionEn: 'Send messages via Telegram bot',
    icon: 'telegram',
    configMethod: 'token',
    configFields: [
      {
        key: 'botToken',
        label: 'Bot Token',
        labelEn: 'Bot Token',
        placeholder: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz',
        placeholderEn: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz',
        type: 'password',
        required: true,
        helpText: '@BotFather 创建机器人获取 token',
      },
      {
        key: 'chatId',
        label: 'Chat ID',
        labelEn: 'Chat ID',
        placeholder: '123456789',
        placeholderEn: '123456789',
        type: 'text',
        required: true,
        helpText: '@userinfobot 获取你的 Chat ID',
      },
    ],
    officialUrl: 'https://core.telegram.org/bots',
    bundled: true,
  },
  {
    id: 'line',
    name: 'LINE',
    nameEn: 'LINE',
    description: '通过 LINE Messaging API 发送消息',
    descriptionEn: 'Send messages via LINE Messaging API',
    icon: 'line',
    configMethod: 'token',
    configFields: [
      {
        key: 'channelId',
        label: 'Channel ID',
        labelEn: 'Channel ID',
        placeholder: '1234567890',
        placeholderEn: '1234567890',
        type: 'text',
        required: true,
      },
      {
        key: 'channelSecret',
        label: 'Channel Secret',
        labelEn: 'Channel Secret',
        placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        placeholderEn: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        type: 'password',
        required: true,
      },
      {
        key: 'userId',
        label: 'User ID',
        labelEn: 'User ID',
        placeholder: 'Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        placeholderEn: 'Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        type: 'text',
        required: true,
        helpText: 'LINE 开发者控制台获取用户 ID',
      },
    ],
    officialUrl: 'https://developers.line.biz/',
    bundled: false,
  },
  {
    id: 'matrix',
    name: 'Matrix',
    nameEn: 'Matrix',
    description: '通过 Matrix 协议发送消息',
    descriptionEn: 'Send messages via Matrix protocol',
    icon: 'matrix',
    configMethod: 'token',
    configFields: [
      {
        key: 'homeserver',
        label: 'Homeserver URL',
        labelEn: 'Homeserver URL',
        placeholder: 'https://matrix.org',
        placeholderEn: 'https://matrix.org',
        type: 'text',
        required: true,
      },
      {
        key: 'accessToken',
        label: 'Access Token',
        labelEn: 'Access Token',
        placeholder: 'eyJ...',
        placeholderEn: 'eyJ...',
        type: 'password',
        required: true,
      },
      {
        key: 'roomId',
        label: 'Room ID',
        labelEn: 'Room ID',
        placeholder: '!room:matrix.org',
        placeholderEn: '!room:matrix.org',
        type: 'text',
        required: true,
      },
    ],
    officialUrl: 'https://matrix.org/',
    bundled: false,
  },
  {
    id: 'mattermost',
    name: 'Mattermost',
    nameEn: 'Mattermost',
    description: '通过 Mattermost 机器人发送消息',
    descriptionEn: 'Send messages via Mattermost bot',
    icon: 'mattermost',
    configMethod: 'token',
    configFields: [
      {
        key: 'webhook',
        label: 'Webhook URL',
        labelEn: 'Webhook URL',
        placeholder: 'https://mattermost.example.com/hooks/...',
        placeholderEn: 'https://mattermost.example.com/hooks/...',
        type: 'text',
        required: true,
      },
    ],
    officialUrl: 'https://docs.mattermost.com/guides/mattermost-operator-guide.html',
    bundled: false,
  },
  {
    id: 'msteams',
    name: 'Microsoft Teams',
    nameEn: 'Microsoft Teams',
    description: '通过 Microsoft Teams 机器人发送消息',
    descriptionEn: 'Send messages via Microsoft Teams bot',
    icon: 'msteams',
    configMethod: 'token',
    configFields: [
      {
        key: 'botId',
        label: 'Bot ID',
        labelEn: 'Bot ID',
        placeholder: '12345678-1234-1234-1234-123456789012',
        placeholderEn: '12345678-1234-1234-1234-123456789012',
        type: 'text',
        required: true,
      },
      {
        key: 'tenantId',
        label: 'Tenant ID',
        labelEn: 'Tenant ID',
        placeholder: '12345678-1234-1234-1234-123456789012',
        placeholderEn: '12345678-1234-1234-1234-123456789012',
        type: 'text',
        required: true,
      },
      {
        key: 'serviceUrl',
        label: 'Service URL',
        labelEn: 'Service URL',
        placeholder: 'https://smba.trafficmanager.net/',
        placeholderEn: 'https://smba.trafficmanager.net/',
        type: 'text',
        required: true,
      },
    ],
    officialUrl: 'https://learn.microsoft.com/en-us/microsoftteams/platform/',
    bundled: false,
  },
  {
    id: 'wxpusher',
    name: '微信推送 (WxPusher)',
    nameEn: 'WeChat Push (WxPusher)',
    description: '通过 WxPusher 微信公众号推送服务发送消息',
    descriptionEn: 'Send messages via WxPusher WeChat notification service',
    icon: 'wechat',
    configMethod: 'token',
    configFields: [
      {
        key: 'appToken',
        label: 'App Token',
        labelEn: 'App Token',
        placeholder: 'AT_xxxxxx',
        placeholderEn: 'AT_xxxxxx',
        type: 'password',
        required: true,
        helpText: '在 WxPusher 后台创建应用获取',
      },
      {
        key: 'uid',
        label: '用户 UID',
        labelEn: 'User UID',
        placeholder: 'UID_xxxxxx',
        placeholderEn: 'UID_xxxxxx',
        type: 'text',
        required: true,
        helpText: '用户关注后获取的 UID',
      },
    ],
    officialUrl: 'https://wxpusher.zjiex.com/',
    bundled: true,
  },
  {
    id: 'qmsg',
    name: 'Qmsg  QQ',
    nameEn: 'Qmsg QQ',
    description: '通过 Qmsg  QQ 机器人发送消息',
    descriptionEn: 'Send messages via Qmsg QQ bot',
    icon: 'qq',
    configMethod: 'token',
    configFields: [
      {
        key: 'key',
        label: 'Key',
        labelEn: 'Key',
        placeholder: 'Qmsg酱的key',
        placeholderEn: 'Qmsg key',
        type: 'password',
        required: true,
        helpText: '在 Qmsg 官网获取 key',
      },
      {
        key: 'qq',
        label: 'QQ 号',
        labelEn: 'QQ Number',
        placeholder: '123456789',
        placeholderEn: '123456789',
        type: 'text',
        required: false,
        helpText: '可选，指定接收消息的 QQ 号',
      },
    ],
    officialUrl: 'https://qmsg.zendee.cn/',
    bundled: true,
  },
  {
    id: 'irc',
    name: 'IRC',
    nameEn: 'IRC',
    description: '通过 IRC 服务器发送消息',
    descriptionEn: 'Send messages via IRC server',
    icon: 'irc',
    configMethod: 'token',
    configFields: [
      {
        key: 'server',
        label: '服务器',
        labelEn: 'Server',
        placeholder: 'irc.libera.chat',
        placeholderEn: 'irc.libera.chat',
        type: 'text',
        required: true,
      },
      {
        key: 'nickname',
        label: '昵称',
        labelEn: 'Nickname',
        placeholder: 'TimeMarkBot',
        placeholderEn: 'TimeMarkBot',
        type: 'text',
        required: true,
      },
      {
        key: 'channel',
        label: '频道',
        labelEn: 'Channel',
        placeholder: '#timemark',
        placeholderEn: '#timemark',
        type: 'text',
        required: true,
      },
    ],
    bundled: false,
  },
  {
    id: 'synologychat',
    name: '群晖 Chat',
    nameEn: 'Synology Chat',
    description: '通过群晖 NAS Chat 套件发送消息',
    descriptionEn: 'Send messages via Synology NAS Chat',
    icon: 'synology',
    configMethod: 'webhook',
    configFields: [
      {
        key: 'webhook',
        label: 'Webhook URL',
        labelEn: 'Webhook URL',
        placeholder: 'https://nas.example.com/webapi/entry.cgi?api=...',
        placeholderEn: 'https://nas.example.com/webapi/entry.cgi?api=...',
        type: 'text',
        required: true,
      },
    ],
    bundled: false,
  },
  {
    id: 'twitch',
    name: 'Twitch',
    nameEn: 'Twitch',
    description: '通过 Twitch IRC 发送消息',
    descriptionEn: 'Send messages via Twitch IRC',
    icon: 'twitch',
    configMethod: 'token',
    configFields: [
      {
        key: 'oauthToken',
        label: 'OAuth Token',
        labelEn: 'OAuth Token',
        placeholder: 'oauth:xxxxxx',
        placeholderEn: 'oauth:xxxxxx',
        type: 'password',
        required: true,
      },
      {
        key: 'channel',
        label: '频道名',
        labelEn: 'Channel Name',
        placeholder: 'your_channel',
        placeholderEn: 'your_channel',
        type: 'text',
        required: true,
      },
    ],
    bundled: false,
  },

  // ============ 插件渠道 (需要安装 npm 包) ============
  {
    id: 'wechat',
    name: '微信 (ClawBot)',
    nameEn: 'WeChat (ClawBot)',
    description: '通过微信 ClawBot 插件发送消息，需要安装 npm 包并扫码授权',
    descriptionEn: 'Send messages via WeChat ClawBot plugin, requires npm package and QR scan',
    icon: 'wechat',
    configMethod: 'plugin',
    configFields: [],
    pluginPackage: '@tencent-weixin/openclaw-weixin',
    docUrl: 'https://docs.openclaw.ai/channels/wechat',
    officialUrl: 'https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin',
    bundled: false,
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    nameEn: 'WhatsApp',
    description: '通过 WhatsApp Web (Baileys) 发送消息，需要扫码配对',
    descriptionEn: 'Send messages via WhatsApp Web (Baileys), requires QR pairing',
    icon: 'whatsapp',
    configMethod: 'plugin',
    configFields: [],
    pluginPackage: 'baileys',
    docUrl: 'https://docs.openclaw.ai/channels/whatsapp',
    bundled: false,
  },
  {
    id: 'qqbot',
    name: 'QQ 机器人',
    nameEn: 'QQ Bot',
    description: '通过 QQ 机器人发送消息',
    descriptionEn: 'Send messages via QQ Bot',
    icon: 'qq',
    configMethod: 'plugin',
    configFields: [],
    pluginPackage: 'openclaw-qqbot',
    docUrl: 'https://docs.openclaw.ai/channels/qqbot',
    bundled: false,
  },
  {
    id: 'signal',
    name: 'Signal',
    nameEn: 'Signal',
    description: '通过 Signal 发送消息',
    descriptionEn: 'Send messages via Signal',
    icon: 'signal',
    configMethod: 'plugin',
    configFields: [],
    pluginPackage: 'signal-cli',
    docUrl: 'https://docs.openclaw.ai/channels/signal',
    bundled: false,
  },
  {
    id: 'zalo',
    name: 'Zalo',
    nameEn: 'Zalo',
    description: '通过 Zalo 发送消息',
    descriptionEn: 'Send messages via Zalo',
    icon: 'zalo',
    configMethod: 'plugin',
    configFields: [],
    pluginPackage: 'openclaw-zalo',
    docUrl: 'https://docs.openclaw.ai/channels/zalo',
    bundled: false,
  },
  {
    id: 'nostr',
    name: 'Nostr',
    nameEn: 'Nostr',
    description: '通过 Nostr 去中心化协议发送消息',
    descriptionEn: 'Send messages via Nostr decentralized protocol',
    icon: 'nostr',
    configMethod: 'plugin',
    configFields: [],
    pluginPackage: 'nostr-tools',
    docUrl: 'https://docs.openclaw.ai/channels/nostr',
    bundled: false,
  },
];

// 获取所有渠道
export function getAllChannels(): ChannelDefinition[] {
  return channels;
}

// 根据 ID 获取渠道
export function getChannelById(id: string): ChannelDefinition | undefined {
  return channels.find((ch) => ch.id === id);
}

// 根据配置方式获取渠道
export function getChannelsByMethod(method: ConfigMethod): ChannelDefinition[] {
  return channels.filter((ch) => ch.configMethod === method);
}

// 获取内置渠道
export function getBundledChannels(): ChannelDefinition[] {
  return channels.filter((ch) => ch.bundled);
}

// 获取插件渠道
export function getPluginChannels(): ChannelDefinition[] {
  return channels.filter((ch) => ch.configMethod === 'plugin');
}
