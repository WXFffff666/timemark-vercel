/**
 * 通知渠道定义和配置
 * 云端部署仅支持 webhook / token 类 HTTP 渠道
 */

import { isSupportedChannel } from './supported-channels.js';
import { CHANNEL_METADATA } from './channels.metadata.js';

export type ChannelConfigMethod = 'webhook' | 'token' | 'plugin';

/** notification_accounts 中实际存储配置值的四个列 */
export type ChannelColumn = 'webhook' | 'token' | 'secret' | 'chat_id';

export interface ChannelField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'textarea' | 'select';
  required: boolean;
  placeholder?: string;
  description?: string;
  /** 该字段在 notification_accounts 中落库的列；缺省时与 name 相同（仅 matrix / pushover 例外） */
  column?: ChannelColumn;
  /** 英文标签（由 Docker 版渠道目录合并而来，用于双语配置手册） */
  labelEn?: string;
  /** 英文占位提示（同来源） */
  placeholderEn?: string;
  /** 字段级帮助文本（同来源） */
  helpText?: string;
}

export interface ChannelTemplate {
  id: string;
  name: string;
  description: string;
  icon: string; // 使用 Lucide icon 名称
  configMethod: ChannelConfigMethod;
  fields: ChannelField[];
  docsUrl?: string;
  pluginPackage?: string;
  pluginInstallCommand?: string;
  // 是否已内置实现（不需要额外npm包）
  isBuiltIn: boolean;
  /** 英文名称（由 Docker 版渠道目录合并而来） */
  nameEn?: string;
  /** 英文描述（同来源） */
  descriptionEn?: string;
  /** 官方集成页面（同来源；缺省时使用 docsUrl） */
  officialUrl?: string;
}

// ============ Webhook-based Channels ============

const webhookChannels: ChannelTemplate[] = [
  {
    id: 'discord',
    name: 'Discord',
    description: 'Discord 频道消息推送',
    icon: 'Gamepad2',
    configMethod: 'webhook',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: 'Webhook URL',
        type: 'text',
        required: true,
        placeholder: 'https://discord.com/api/webhooks/...',
        description: '从 Discord 频道设置中获取 Webhook URL'
      }
    ],
    docsUrl: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks'
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Slack 频道消息推送',
    icon: 'Hash',
    configMethod: 'webhook',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: 'Webhook URL',
        type: 'text',
        required: true,
        placeholder: 'https://hooks.slack.com/services/...',
        description: '从 Slack 应用管理中创建 Incoming Webhook'
      }
    ],
    docsUrl: 'https://api.slack.com/messaging/webhooks'
  },
  {
    id: 'feishu',
    name: '飞书 (Feishu)',
    description: '飞书群聊机器人',
    icon: 'MessageSquare',
    configMethod: 'webhook',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: 'Webhook URL',
        type: 'text',
        required: true,
        placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...',
        description: '在飞书群设置中添加机器人获取 Webhook 地址'
      }
    ],
    docsUrl: 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot'
  },
  {
    id: 'wecom',
    name: '企业微信 (WeCom)',
    description: '企业微信群聊机器人',
    icon: 'Building2',
    configMethod: 'webhook',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: 'Webhook URL',
        type: 'text',
        required: true,
        placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...',
        description: '在企业微信群设置中添加群机器人获取 Webhook 地址'
      }
    ],
    docsUrl: 'https://developer.work.weixin.qq.com/document/path/91770'
  },
  {
    id: 'dingtalk',
    name: '钉钉 (DingTalk)',
    description: '钉钉群聊机器人（支持加签验证）',
    icon: 'MessageCircle',
    configMethod: 'webhook',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: 'Webhook URL',
        type: 'text',
        required: true,
        placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...',
        description: '在钉钉群设置中添加机器人获取 Webhook 地址'
      },
      {
        name: 'secret',
        label: '加签密钥 (可选)',
        type: 'password',
        required: false,
        placeholder: 'SEC...',
        description: '如需加签验证，请填写安全设置的加签密钥'
      }
    ],
    docsUrl: 'https://open.dingtalk.com/document/robots/custom-robot-access'
  },
  {
    id: 'googlechat',
    name: 'Google Chat',
    description: 'Google Chat 空间消息推送',
    icon: 'MessageSquare',
    configMethod: 'webhook',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: 'Webhook URL',
        type: 'text',
        required: true,
        placeholder: 'https://chat.googleapis.com/v1/spaces/...',
        description: '在 Google Chat 空间设置中创建 Webhook'
      }
    ],
    docsUrl: 'https://developers.google.com/chat/how-tos/webhooks'
  },
  {
    id: 'irc',
    name: 'IRC',
    description: 'IRC 频道消息推送',
    icon: 'Terminal',
    configMethod: 'webhook',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: 'Webhook URL',
        type: 'text',
        required: true,
        placeholder: 'https://your-matterbridge-url/...',
        description: 'IRC 桥接 Webhook URL（如 matterbridge）'
      }
    ],
    docsUrl: 'https://github.com/42wim/matterbridge/wiki'
  },
  {
    id: 'synologychat',
    name: 'Synology Chat',
    description: '群晖 Chat 消息推送',
    icon: 'Server',
    configMethod: 'webhook',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: 'Webhook URL',
        type: 'text',
        required: true,
        placeholder: 'https://your-nas:5001/webapi/entry.cgi?...',
        description: '在 Synology Chat 中创建传入 Webhook'
      }
    ],
    docsUrl: 'https://kb.synology.com/en-global/DSM/help/Chat/chat_integration'
  },
  {
    id: 'twitch',
    name: 'Twitch',
    description: 'Twitch 直播聊天消息',
    icon: 'Video',
    configMethod: 'webhook',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: 'Webhook URL',
        type: 'text',
        required: true,
        placeholder: 'https://api.twitch.tv/helix/...',
        description: 'Twitch EventSub Webhook URL'
      }
    ],
    docsUrl: 'https://dev.twitch.tv/docs/eventsub/'
  },
  {
    id: 'generic_webhook',
    name: '自定义 Webhook',
    description: '通用 Webhook 推送',
    icon: 'Webhook',
    configMethod: 'webhook',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: 'Webhook URL',
        type: 'text',
        required: true,
        placeholder: 'https://your-webhook-endpoint.com/...',
        description: '自定义 Webhook 接收地址'
      },
      {
        name: 'secret',
        label: 'Secret Key (可选)',
        type: 'password',
        required: false,
        placeholder: '用于验证请求签名',
        description: '用于验证 Webhook 请求的密钥'
      }
    ],
    docsUrl: 'https://developer.mozilla.org/en-US/docs/Web/API/Webhooks'
  },
  {
    id: 'rocketchat',
    name: 'Rocket.Chat',
    description: 'Rocket.Chat 频道消息推送（传入 Webhook）',
    icon: 'MessageSquare',
    configMethod: 'webhook',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: 'Webhook URL',
        type: 'text',
        required: true,
        placeholder: 'https://your-server/hooks/{integrationId}/{token}',
        description: 'Rocket.Chat → 管理 → 集成 → 传入 Webhook，复制完整 URL'
      }
    ],
    docsUrl: 'https://docs.rocket.chat/docs/integrations'
  }
];

// ============ Token-based Channels ============

const tokenChannels: ChannelTemplate[] = [
  {
    id: 'resend',
    name: 'Resend',
    description: 'Resend 邮件 API 推送（支持 HTML 模板）',
    icon: 'Mail',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'Resend API Key',
        type: 'password',
        required: true,
        placeholder: 're_...',
        description: '从 Resend 官网获取的 API Key'
      },
      {
        name: 'webhook',
        label: '发件人邮箱',
        type: 'text',
        required: false,
        placeholder: 'noreply@yourdomain.com',
        description: '已验证域名的邮箱地址，如 noreply@email.the37777777.top。留空使用测试地址 onboarding@resend.dev（仅能发送到自己的邮箱）'
      },
      {
        name: 'chat_id',
        label: '收件人邮箱',
        type: 'text',
        required: false,
        placeholder: 'you@example.com',
        description: '本渠道的默认收件地址。留空时将使用「设置 → 通知默认邮箱」中的默认测试邮箱'
      }
    ],
    docsUrl: 'https://resend.com/docs'
  },
  {
    id: 'smtp',
    name: 'SMTP 邮件',
    description: '大厂邮箱 SMTP 发信（QQ / 163 / Gmail / Outlook / 腾讯企业邮 / 阿里企业邮等）',
    icon: 'Mail',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'chat_id',
        label: '发件人邮箱',
        type: 'text',
        required: true,
        placeholder: 'yourname@qq.com',
        description: '完整邮箱地址，同时作为 SMTP 登录用户名'
      },
      {
        name: 'token',
        label: '授权码 / 应用密码',
        type: 'password',
        required: true,
        description: 'QQ/163 填授权码；Gmail 填应用专用密码；企业邮填邮箱密码或客户端密码'
      },
      {
        name: 'webhook',
        label: 'SMTP 服务器',
        type: 'text',
        required: true,
        placeholder: 'smtp.qq.com',
        description: '选择邮箱服务商后自动填充；自定义时可手动修改'
      },
      {
        name: 'secret',
        label: 'SMTP 端口',
        type: 'text',
        required: true,
        placeholder: '465',
        description: '常用 465（SSL）或 587（STARTTLS）'
      }
    ],
    docsUrl: 'https://nodemailer.com/about/'
  },
  {
    id: 'telegram',
    name: 'Telegram',
    description: 'Telegram Bot 消息推送',
    icon: 'Send',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'Bot Token',
        type: 'password',
        required: true,
        placeholder: '123456789:ABCdefGHIjklMNOpqrsTUVwxyz...',
        description: '从 @BotFather 获取的 Bot Token'
      },
      {
        name: 'chat_id',
        label: 'Chat ID',
        type: 'text',
        required: true,
        placeholder: '123456789 或 @channelusername',
        description: '目标聊天 ID（可以是用户 ID 或频道用户名）'
      }
    ],
    docsUrl: 'https://core.telegram.org/bots/tutorial'
  },
  {
    id: 'line',
    name: 'LINE',
    description: 'LINE Messaging API 推送',
    icon: 'MessageSquare',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'Channel Access Token',
        type: 'password',
        required: true,
        placeholder: 'Bearer ...',
        description: 'LINE Channel Access Token'
      },
      {
        name: 'chat_id',
        label: '用户 ID 或群组 ID',
        type: 'text',
        required: true,
        placeholder: 'U1234567890abcdef...',
        description: '目标用户或群组的 ID'
      }
    ],
    docsUrl: 'https://developers.line.biz/en/docs/messaging-api/overview/'
  },
  {
    id: 'matrix',
    name: 'Matrix',
    description: 'Matrix 消息推送',
    icon: 'Grid3X3',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'homeserver',
        label: 'Homeserver URL',
        type: 'text',
        required: true,
        placeholder: 'https://matrix.org',
        description: 'Matrix Homeserver 地址',
        column: 'webhook'
      },
      {
        name: 'token',
        label: 'Access Token',
        type: 'password',
        required: true,
        placeholder: 'syt_...',
        description: 'Matrix 访问令牌'
      },
      {
        name: 'roomId',
        label: 'Room ID',
        type: 'text',
        required: true,
        placeholder: '!roomid:matrix.org',
        description: '目标房间 ID',
        column: 'chat_id'
      }
    ],
    docsUrl: 'https://matrix.org/docs/legacy/client-server-api/'
  },
  {
    id: 'mattermost',
    name: 'Mattermost',
    description: 'Mattermost 消息推送',
    icon: 'MessageSquare',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: '服务器 URL',
        type: 'text',
        required: true,
        placeholder: 'https://mattermost.example.com',
        description: 'Mattermost 服务器地址'
      },
      {
        name: 'token',
        label: 'Bot Access Token',
        type: 'password',
        required: true,
        placeholder: 'your-bot-token',
        description: '从 Mattermost 集成中创建的 Bot Token'
      },
      {
        name: 'chat_id',
        label: '频道 ID',
        type: 'text',
        required: true,
        placeholder: 'channel-id',
        description: '目标频道 ID'
      }
    ],
    docsUrl: 'https://developers.mattermost.com/integrate/reference/bot-accounts/'
  },
  {
    id: 'msteams',
    name: 'Microsoft Teams',
    description: 'Microsoft Teams 消息推送',
    icon: 'Teams',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'Bot Framework Token',
        type: 'password',
        required: true,
        description: 'Microsoft Bot Framework 令牌'
      },
      {
        name: 'chat_id',
        label: 'Teams 频道 ID',
        type: 'text',
        required: true,
        description: '目标 Teams 频道 ID'
      }
    ],
    docsUrl: 'https://docs.microsoft.com/en-us/microsoftteams/platform/bots/what-are-bots'
  },
  {
    id: 'nextcloud_talk',
    name: 'Nextcloud Talk',
    description: 'Nextcloud Talk 消息推送',
    icon: 'Cloud',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: 'Nextcloud URL',
        type: 'text',
        required: true,
        placeholder: 'https://cloud.example.com',
        description: 'Nextcloud 服务器地址'
      },
      {
        name: 'token',
        label: 'App Password',
        type: 'password',
        required: true,
        description: 'Nextcloud 应用密码'
      },
      {
        name: 'chat_id',
        label: 'Talk 房间 Token',
        type: 'text',
        required: true,
        description: 'Talk 房间的 token'
      }
    ],
    docsUrl: 'https://nextcloud-talk.readthedocs.io/en/latest/'
  },
  {
    id: 'nostr',
    name: 'Nostr',
    description: 'Nostr 协议加密私信推送 (NIP-04)',
    icon: 'Zap',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: '私钥 (hex)',
        type: 'password',
        required: true,
        description: 'Nostr 私钥（hex 格式，请妥善保管）'
      },
      {
        name: 'chat_id',
        label: '目标公钥 (hex)',
        type: 'text',
        required: true,
        description: '接收消息的公钥（hex 格式）'
      },
      {
        name: 'webhook',
        label: '中继地址 (可选)',
        type: 'text',
        required: false,
        placeholder: 'wss://relay.damus.io',
        description: '自定义 Nostr 中继地址，留空使用默认中继'
      }
    ],
    docsUrl: 'https://github.com/nostr-protocol/nostr'
  },
  {
    id: 'wxpusher',
    name: 'WxPusher',
    description: '微信服务号消息推送（无需认证公众号）',
    icon: 'MessageCircle',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'AppToken',
        type: 'password',
        required: true,
        description: '在 WxPusher 后台创建应用获取的 AppToken'
      },
      {
        name: 'chat_id',
        label: 'UID',
        type: 'text',
        required: true,
        placeholder: 'UID_...',
        description: '用户订阅后获取的 UID'
      }
    ],
    docsUrl: 'https://wxpusher.zjiecode.com/docs/'
  },
  {
    id: 'qmsg',
    name: 'Qmsg',
    description: 'QQ 消息推送',
    icon: 'MessageCircle',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'Qmsg Key',
        type: 'password',
        required: true,
        description: '从 Qmsg 官网获取的 Key'
      },
      {
        name: 'chat_id',
        label: 'QQ 号码',
        type: 'text',
        required: true,
        placeholder: '123456789',
        description: '接收消息的 QQ 号码'
      }
    ],
    docsUrl: 'https://qmsg.zendee.cn/'
  },

  {
    id: 'serverchan',
    name: 'Server酱 (ServerChan)',
    description: 'Server酱消息推送',
    icon: 'Radio',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'SendKey',
        type: 'password',
        required: true,
        placeholder: 'SCT...',
        description: '从 Server酱 官网获取的 SendKey'
      }
    ],
    docsUrl: 'https://sct.ftqq.com/'
  },
  {
    id: 'pushplus',
    name: 'PushPlus',
    description: 'PushPlus 消息推送',
    icon: 'BellPlus',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'Token',
        type: 'password',
        required: true,
        description: '从 PushPlus 官网获取的 Token'
      },
      {
        name: 'chat_id',
        label: '群组编码 (可选)',
        type: 'text',
        required: false,
        placeholder: 'topic',
        description: '群组编码，不填仅发送给自己'
      }
    ],
    docsUrl: 'https://www.pushplus.plus/doc/'
  },
  {
    id: 'bark',
    name: 'Bark',
    description: 'Bark iOS 推送通知',
    icon: 'Smartphone',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: '服务器地址',
        type: 'text',
        required: true,
        placeholder: 'https://api.day.app',
        description: 'Bark 服务器地址'
      },
      {
        name: 'token',
        label: 'Device Key',
        type: 'password',
        required: true,
        description: 'Bark 设备推送 Key'
      },
      {
        name: 'chat_id',
        label: '分组 (可选)',
        type: 'text',
        required: false,
        placeholder: 'TimeMark',
        description: '推送消息分组'
      },
      {
        name: 'secret',
        label: '铃声 (可选)',
        type: 'text',
        required: false,
        placeholder: 'birdsong',
        description: '推送铃声名称'
      }
    ],
    docsUrl: 'https://bark.day.app/'
  },
  {
    id: 'gotify',
    name: 'Gotify',
    description: 'Gotify 自托管推送服务',
    icon: 'Bell',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: '服务器地址',
        type: 'text',
        required: true,
        placeholder: 'https://gotify.example.com',
        description: 'Gotify 服务器地址'
      },
      {
        name: 'token',
        label: 'App Token',
        type: 'password',
        required: true,
        description: 'Gotify 应用 Token'
      },
      {
        name: 'chat_id',
        label: '优先级 (可选)',
        type: 'text',
        required: false,
        placeholder: '5',
        description: '消息优先级，默认为 5'
      }
    ],
    docsUrl: 'https://gotify.net/docs/'
  },
  {
    id: 'meow',
    name: '喵推送 (Meow)',
    description: '喵推送消息推送',
    icon: 'Cat',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: '昵称 (Nickname)',
        type: 'text',
        required: true,
        description: '喵推送的用户昵称'
      }
    ],
    docsUrl: 'https://meopush.com/'
  },
  {
    id: 'pushme',
    name: 'PushMe',
    description: 'PushMe 消息推送',
    icon: 'SendHorizontal',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'Push Key',
        type: 'password',
        required: true,
        description: '从 PushMe 获取的推送 Key'
      }
    ],
    docsUrl: 'https://push.i-i.me/'
  },
  {
    id: 'pushdeer',
    name: 'PushDeer',
    description: 'PushDeer 跨平台推送（iOS/Android）',
    icon: 'BellRing',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'PushKey',
        type: 'password',
        required: true,
        description: '从 PushDeer App 或官网获取的 PushKey'
      },
      {
        name: 'webhook',
        label: 'API 地址（可选）',
        type: 'text',
        required: false,
        placeholder: 'https://api2.pushdeer.com',
        description: '自建 PushDeer 服务地址，留空使用官方 API'
      }
    ],
    docsUrl: 'https://www.pushdeer.com/'
  },
  {
    id: 'twilio',
    name: 'Twilio SMS',
    description: '通过 Twilio 发送短信提醒',
    icon: 'Phone',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'Account SID',
        type: 'password',
        required: true,
        description: 'Twilio 控制台 Account SID',
      },
      {
        name: 'secret',
        label: 'Auth Token',
        type: 'password',
        required: true,
        description: 'Twilio Auth Token',
      },
      {
        name: 'webhook',
        label: '发信号码 (From)',
        type: 'text',
        required: true,
        placeholder: '+1234567890',
        description: '已验证的 Twilio 发信号码',
      },
      {
        name: 'chat_id',
        label: '收件号码 (To)',
        type: 'text',
        required: true,
        placeholder: '+8613800138000',
        description: '接收短信的手机号',
      },
    ],
    docsUrl: 'https://www.twilio.com/docs/sms',
  },
  {
    id: 'wecomapp',
    name: '企微应用 (WeComApp)',
    description: '企业微信应用消息推送',
    icon: 'Building',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'CorpID',
        type: 'text',
        required: true,
        description: '企业微信的企业 ID'
      },
      {
        name: 'secret',
        label: 'CorpSecret',
        type: 'password',
        required: true,
        description: '应用的 Secret'
      },
      {
        name: 'chat_id',
        label: 'AgentID',
        type: 'text',
        required: true,
        description: '应用的 AgentID'
      },
      {
        name: 'webhook',
        label: '接收人 (touser)',
        type: 'text',
        required: true,
        placeholder: '@all',
        description: '接收消息的用户 ID，多个用 | 分隔，@all 表示全部'
      }
    ],
    docsUrl: 'https://developer.work.weixin.qq.com/document/path/90236'
  },
  {
    id: 'ntfy',
    name: 'Ntfy',
    description: 'Ntfy 自托管推送通知服务',
    icon: 'Bell',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: '服务器地址',
        type: 'text',
        required: true,
        placeholder: 'https://ntfy.sh',
        description: 'Ntfy 服务器地址（默认 https://ntfy.sh 或自托管地址）'
      },
      {
        name: 'token',
        label: 'Topic',
        type: 'text',
        required: true,
        placeholder: 'my-timemark-topic',
        description: '订阅的 Topic 名称'
      }
    ],
    docsUrl: 'https://docs.ntfy.sh/'
  },
  {
    id: 'pushover',
    name: 'Pushover',
    description: 'Pushover 跨平台推送通知',
    icon: 'BellRing',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'User Key',
        type: 'password',
        required: true,
        description: 'Pushover 用户密钥'
      },
      {
        name: 'secret',
        label: 'App Token',
        type: 'password',
        required: true,
        description: 'Pushover 应用 API Token'
      },
      {
        name: 'priority',
        label: '优先级',
        type: 'select',
        required: false,
        description: 'Pushover 消息优先级（-2 静默 ~ 2 紧急）',
        placeholder: '0',
        column: 'chat_id'
      }
    ],
    docsUrl: 'https://pushover.net/api'
  },
  {
    id: 'apprise',
    name: 'Apprise',
    description: 'Apprise 统一通知网关（支持 80+ 服务）',
    icon: 'Globe',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: 'Apprise 服务器地址',
        type: 'text',
        required: true,
        placeholder: 'http://localhost:8000',
        description: 'Apprise API 服务器地址'
      },
      {
        name: 'token',
        label: '通知 URLs (可选)',
        type: 'textarea',
        required: false,
        placeholder: 'tgram://bottoken/ChatID\nslack://TokenA/TokenB/TokenC',
        description: '通知服务 URL 列表（每行一个），留空使用服务器默认配置'
      }
    ],
    docsUrl: 'https://github.com/caronc/apprise-api'
  },
  {
    id: 'serverchan3',
    name: 'Server酱³ (SC3)',
    description: 'Server酱³ 消息推送（SC3，与 Turbo 不同的新产品）',
    icon: 'Radio',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'SendKey (sctp...)',
        type: 'password',
        required: true,
        placeholder: 'sctp...t...',
        description: 'SC3 的 SendKey（以 sctp 开头），不是 Turbo 的 SCT 开头 key'
      },
      {
        name: 'webhook',
        label: 'UID (可选)',
        type: 'text',
        required: false,
        placeholder: '1234',
        description: '留空时自动从 SendKey 的 sctp<UID>t 段推导；推导失败会给出明确错误'
      }
    ],
    docsUrl: 'https://sct.ftqq.com/compare/'
  },
  {
    id: 'xizhi',
    name: '息知 (XiZhi)',
    description: '息知微信推送（xizhi.qqoq.net）',
    icon: 'MessageCircle',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: '息知 Key',
        type: 'password',
        required: true,
        description: '息知后台复制 key（推送地址 https://xizhi.qqoq.net/{key}.send 中的 {key}）'
      }
    ],
    docsUrl: 'https://xz.qqoq.net/'
  },
  {
    id: 'anpush',
    name: 'AnPush',
    description: 'AnPush 多渠道推送',
    icon: 'BellRing',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'Push Token',
        type: 'password',
        required: true,
        description: 'AnPush 控制台获取的推送 Token'
      },
      {
        name: 'chat_id',
        label: '通道 ID (可选)',
        type: 'text',
        required: false,
        description: '指定推送通道 channel，留空使用 AnPush 默认通道'
      }
    ],
    docsUrl: 'https://anpush.com/'
  },
  {
    id: 'chanify',
    name: 'Chanify',
    description: 'Chanify iOS 推送（支持自建服务端）',
    icon: 'Smartphone',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: '服务器地址 (可选)',
        type: 'text',
        required: false,
        placeholder: 'https://api.chanify.net',
        description: '自建 Chanify 服务地址；留空使用官方公共服务'
      },
      {
        name: 'token',
        label: '设备 Token',
        type: 'password',
        required: true,
        description: 'Chanify App → 通道 → 复制 Send Token'
      }
    ],
    docsUrl: 'https://github.com/chanify/chanify-ios'
  },
  {
    id: 'pushback',
    name: 'Pushback',
    description: 'Pushback 可回复通知',
    icon: 'Bell',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'Access Token (at_...)',
        type: 'password',
        required: true,
        placeholder: 'at_...',
        description: 'Pushback 控制台获取的 access token'
      },
      {
        name: 'chat_id',
        label: 'User ID (User_...)',
        type: 'text',
        required: true,
        placeholder: 'User_1234',
        description: '接收通知的 User ID'
      }
    ],
    docsUrl: 'https://pushback.io/docs/getting-started'
  },
  {
    id: 'simplepush',
    name: 'SimplePush',
    description: 'SimplePush 简单推送',
    icon: 'Zap',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'Key',
        type: 'password',
        required: true,
        description: 'SimplePush App 中显示的 key'
      }
    ],
    docsUrl: 'https://simplepush.io/'
  },
  {
    id: 'zulip',
    name: 'Zulip',
    description: 'Zulip 流消息推送',
    icon: 'Hash',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: '组织地址',
        type: 'text',
        required: true,
        placeholder: 'https://your-org.zulipchat.com',
        description: 'Zulip 组织 URL（只填到域名，不要带 /api 等路径）'
      },
      {
        name: 'token',
        label: 'API Key',
        type: 'password',
        required: true,
        description: '机器人账号的 API Key（设置 → 账户与隐私 → 机器人）'
      },
      {
        name: 'chat_id',
        label: 'Bot 邮箱',
        type: 'text',
        required: true,
        placeholder: 'bot@your-org.zulipchat.com',
        description: '机器人账号邮箱（HTTP Basic 用户名）'
      },
      {
        name: 'secret',
        label: 'Stream 名称',
        type: 'text',
        required: true,
        placeholder: 'time-reminders',
        description: '接收消息的 stream'
      }
    ],
    docsUrl: 'https://zulip.com/api/send-message'
  },
  {
    id: 'fcm',
    name: 'Firebase 推送 (FCM)',
    description: 'Firebase Cloud Messaging HTTP v1',
    icon: 'Flame',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: '服务账号 JSON',
        type: 'textarea',
        required: true,
        placeholder: '{"type":"service_account", ...}',
        description: 'Firebase 控制台 → 项目设置 → 服务账号 → 生成新的私钥，粘贴整份 JSON（AES 加密存储）'
      },
      {
        name: 'chat_id',
        label: '设备令牌 / topic',
        type: 'text',
        required: true,
        placeholder: 'fcm-device-token 或 topic:alerts',
        description: '设备注册令牌，或 topic:<主题名>'
      }
    ],
    docsUrl: 'https://firebase.google.com/docs/cloud-messaging/send/v1-api'
  },
  {
    id: 'twilio_whatsapp',
    name: 'Twilio WhatsApp',
    description: '通过 Twilio 发送 WhatsApp 消息',
    icon: 'MessageCircle',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: 'Account SID',
        type: 'password',
        required: true,
        description: 'Twilio 控制台 Account SID'
      },
      {
        name: 'secret',
        label: 'Auth Token',
        type: 'password',
        required: true,
        description: 'Twilio Auth Token'
      },
      {
        name: 'webhook',
        label: '发信号码 (From)',
        type: 'text',
        required: true,
        placeholder: '+14155238886',
        description: 'Twilio WhatsApp 发信号码（发送时自动加 whatsapp: 前缀）'
      },
      {
        name: 'chat_id',
        label: '收件号码 (To)',
        type: 'text',
        required: true,
        placeholder: '+8613800138000',
        description: '接收 WhatsApp 消息的手机号（发送时自动加 whatsapp: 前缀）'
      }
    ],
    docsUrl: 'https://www.twilio.com/docs/whatsapp/api'
  }
];

// ============ All Channel Templates ============

/**
 * 合并 Docker 版渠道目录的展示元数据（officialUrl / 英文标签 / helpText）。
 * R5.2：`shared/src/channels.ts` 已删除，这里是唯一权威渠道目录；
 * 元数据缺失时按原模板返回（可正常降级）。
 */
function applyChannelMetadata(template: ChannelTemplate): ChannelTemplate {
  const meta = CHANNEL_METADATA[template.id];
  if (!meta) return template;
  return {
    ...template,
    nameEn: meta.nameEn ?? template.nameEn,
    descriptionEn: meta.descriptionEn ?? template.descriptionEn,
    officialUrl: meta.officialUrl ?? template.officialUrl,
    fields: template.fields.map((field) => {
      const fieldMeta = meta.fields?.[field.name];
      return fieldMeta ? { ...field, ...fieldMeta } : field;
    }),
  };
}

export const allChannelTemplates: ChannelTemplate[] = [
  ...webhookChannels,
  ...tokenChannels.filter((c) => c.id !== 'nostr'),
].map(applyChannelMetadata);

export function getSupportedChannelTemplates(): ChannelTemplate[] {
  return allChannelTemplates.filter((c) => c.configMethod !== 'plugin' && isSupportedChannel(c.id));
}

export function getSupportedChannelsByMethod(method: ChannelConfigMethod): ChannelTemplate[] {
  return getSupportedChannelTemplates().filter((c) => c.configMethod === method);
}

// ============ Channel Helpers ============

export function getChannelTemplate(channelId: string): ChannelTemplate | undefined {
  return getSupportedChannelTemplates().find((c) => c.id === channelId);
}

export function getChannelsByMethod(method: ChannelConfigMethod): ChannelTemplate[] {
  return getSupportedChannelsByMethod(method);
}

export function isBuiltInChannel(channelId: string): boolean {
  const template = getChannelTemplate(channelId);
  return template?.isBuiltIn ?? false;
}

export function getConfigMethod(channelId: string): ChannelConfigMethod {
  const template = getChannelTemplate(channelId);
  return template?.configMethod || 'webhook';
}

// ============ Legacy Channel Mapping (for backward compatibility) ============

export const legacyChannelToAccountType: Record<string, string> = {
  'feishu': 'feishu',
  'wecom': 'wecom',
  'dingtalk': 'dingtalk',
  'telegram': 'telegram',
  'discord': 'discord',
  'slack': 'slack',
  'wechat': 'wxpusher',
  'wechat_official': 'wxpusher',
  'qq': 'qmsg',
  'email': 'email',
  'resend': 'resend',
};
