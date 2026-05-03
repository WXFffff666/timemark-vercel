/**
 * 通知渠道定义和配置
 * 按照 OpenClaw 的方式组织渠道，分为三类：
 * - webhook: 只需要 Webhook URL
 * - token: 需要 Bot Token 和可选的其他参数
 * - plugin: 需要安装 npm 包并扫码授权
 */

export type ChannelConfigMethod = 'webhook' | 'token' | 'plugin';

export interface ChannelField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'textarea' | 'select';
  required: boolean;
  placeholder?: string;
  description?: string;
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
        label: '发送邮箱',
        type: 'text',
        required: true,
        placeholder: 'onboarding@resend.dev',
        description: '发件人邮箱地址（需在 Resend 中验证）'
      },
      {
        name: 'chat_id',
        label: '接收邮箱',
        type: 'text',
        required: true,
        placeholder: 'user@example.com',
        description: '收件人邮箱地址'
      }
    ],
    docsUrl: 'https://resend.com/docs'
  },
  {
    id: 'smtp',
    name: 'SMTP 邮件',
    description: 'SMTP 协议邮件推送（支持 Gmail、Outlook、自建邮箱等）',
    icon: 'Mail',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'webhook',
        label: 'SMTP 服务器',
        type: 'text',
        required: true,
        placeholder: 'smtp.gmail.com',
        description: 'SMTP 服务器地址'
      },
      {
        name: 'secret',
        label: 'SMTP 端口',
        type: 'text',
        required: true,
        placeholder: '587',
        description: 'SMTP 端口号（通常 587 或 465）'
      },
      {
        name: 'token',
        label: '邮箱密码/授权码',
        type: 'password',
        required: true,
        description: '邮箱密码或应用专用密码/授权码'
      },
      {
        name: 'chat_id',
        label: '发件人邮箱',
        type: 'text',
        required: true,
        placeholder: 'user@gmail.com',
        description: '发件人邮箱地址（也用作 SMTP 用户名和收件人）'
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
        description: 'Matrix Homeserver 地址'
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
        description: '目标房间 ID'
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
    description: 'Nostr 协议消息推送',
    icon: 'Zap',
    configMethod: 'token',
    isBuiltIn: true,
    fields: [
      {
        name: 'token',
        label: '私钥 (nsec)',
        type: 'password',
        required: true,
        description: 'Nostr 私钥（请妥善保管）'
      },
      {
        name: 'chat_id',
        label: '目标公钥 (npub)',
        type: 'text',
        required: true,
        description: '接收消息的公钥'
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
  }
];

// ============ Plugin-based Channels ============

const pluginChannels: ChannelTemplate[] = [
  {
    id: 'wechat_personal',
    name: '微信个人号',
    description: '微信个人号消息推送（扫码登录）',
    icon: 'Smartphone',
    configMethod: 'plugin',
    isBuiltIn: true,
    pluginPackage: 'wechaty',
    fields: [
      {
        name: 'session_data',
        label: '认证会话',
        type: 'textarea',
        required: false,
        description: '扫码登录后自动填充的会话数据'
      }
    ],
    docsUrl: 'https://wechaty.js.org/'
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    description: 'WhatsApp 消息推送（扫码配对）',
    icon: 'Phone',
    configMethod: 'plugin',
    isBuiltIn: true,
    pluginPackage: '@whiskeysockets/baileys',
    fields: [
      {
        name: 'session_data',
        label: '认证会话',
        type: 'textarea',
        required: false,
        description: '扫码配对后自动填充的会话数据'
      }
    ],
    docsUrl: 'https://github.com/WhiskeySockets/Baileys'
  },
  {
    id: 'qq_bot',
    name: 'QQ Bot',
    description: 'QQ 机器人消息推送（扫码登录）',
    icon: 'MessageCircle',
    configMethod: 'plugin',
    isBuiltIn: true,
    pluginPackage: 'oicq',
    fields: [
      {
        name: 'token',
        label: 'QQ 号码',
        type: 'text',
        required: true,
        placeholder: '123456789',
        description: '机器人的 QQ 号码'
      },
      {
        name: 'session_data',
        label: '认证会话',
        type: 'textarea',
        required: false,
        description: '扫码登录后自动填充的会话数据'
      }
    ],
    docsUrl: 'https://oicqjs.github.io/oicq/'
  },
  {
    id: 'signal',
    name: 'Signal',
    description: 'Signal 消息推送（需安装 signal-cli）',
    icon: 'Shield',
    configMethod: 'plugin',
    isBuiltIn: true,
    pluginPackage: 'signal-cli',
    pluginInstallCommand: '# 需安装 signal-cli 命令行工具',
    fields: [
      {
        name: 'token',
        label: '电话号码',
        type: 'text',
        required: true,
        placeholder: '+86138xxxxxxxx',
        description: 'Signal 注册的手机号码'
      },
      {
        name: 'session_data',
        label: '认证会话',
        type: 'textarea',
        required: false,
        description: '验证后自动填充的会话数据'
      }
    ],
    docsUrl: 'https://github.com/AsamK/signal-cli'
  },
  {
    id: 'imessage',
    name: 'iMessage',
    description: 'iMessage 消息推送（需 macOS 设备）',
    icon: 'MessageSquare',
    configMethod: 'plugin',
    isBuiltIn: true,
    pluginPackage: 'imessage-exporter',
    fields: [
      {
        name: 'session_data',
        label: '设备配置',
        type: 'textarea',
        required: false,
        description: 'macOS 设备配置信息'
      }
    ],
    docsUrl: 'https://bluebubbles.app/'
  },
  {
    id: 'zalo',
    name: 'Zalo',
    description: 'Zalo 消息推送（越南版微信）',
    icon: 'MessageCircle',
    configMethod: 'plugin',
    isBuiltIn: true,
    pluginPackage: 'zalo-messenger',
    pluginInstallCommand: 'npm install axios',
    fields: [
      {
        name: 'token',
        label: 'Access Token',
        type: 'password',
        required: true,
        description: 'Zalo OA 后台获取的 Access Token'
      },
      {
        name: 'session_data',
        label: '认证会话',
        type: 'textarea',
        required: false,
        description: '扫码登录后自动填充的会话数据'
      }
    ],
    docsUrl: 'https://developers.zalo.com/'
  },
  {
    id: 'clawbot',
    name: '微信龙虾 (ClawBot)',
    description: '微信龙虾机器人消息推送（扫码登录）',
    icon: 'Bot',
    configMethod: 'plugin',
    isBuiltIn: true,
    pluginPackage: 'ilink-clawbot-api',
    fields: [
      {
        name: 'session_data',
        label: '认证会话',
        type: 'textarea',
        required: false,
        description: '扫码登录后自动填充的会话数据'
      }
    ],
    docsUrl: 'https://github.com/nicepkg/wechat-clawbot'
  }
];

// ============ All Channel Templates ============

export const allChannelTemplates: ChannelTemplate[] = [
  ...webhookChannels,
  ...tokenChannels,
  ...pluginChannels
];

// ============ Channel Helpers ============

export function getChannelTemplate(channelId: string): ChannelTemplate | undefined {
  return allChannelTemplates.find(c => c.id === channelId);
}

export function getChannelsByMethod(method: ChannelConfigMethod): ChannelTemplate[] {
  return allChannelTemplates.filter(c => c.configMethod === method);
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
  'wechat_personal': 'wechat_personal',
  'qq': 'qmsg',
  'qq_bot': 'qmsg',
  'email': 'email',
  'resend': 'resend',
};
