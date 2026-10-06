/**
 * 渠道补充元数据（官方集成页 + 英文标签/描述 + 字段帮助文本）
 *
 * 来源：Docker 版渠道目录 `shared/src/channels.ts`（已随 R5.2 合并删除）。
 * 该文件只保存「展示用」元数据，运行时真值仍是 `channels.config.ts` 的渠道列表与字段映射。
 * `channels.config.ts` 在构造 allChannelTemplates 时把这里的数据合并进模板：
 *   - officialUrl   → ChannelTemplate.officialUrl（缺省时矩阵回退 docsUrl）
 *   - nameEn / descriptionEn → 模板英文名/描述
 *   - fields[name]  → 对同名字段补充 labelEn / placeholderEn / helpText
 *
 * 注意：Docker 版原文件里的 wecom 官方链接为乱码（`document/镇区/...`），
 * 这里已替换为有效的官方文档地址；wxpusher 的 `zjiex.com` 域名笔误也已修正为
 * `zjiecode.com`。新增渠道（bark/gotify/… 及 Wave 2 的 11 个）没有对应条目，
 * 生成器与前端均按“无元数据”正常降级。
 */

export interface ChannelFieldMetadata {
  labelEn?: string;
  placeholderEn?: string;
  helpText?: string;
}

export interface ChannelMetadata {
  nameEn?: string;
  descriptionEn?: string;
  officialUrl?: string;
  fields?: Record<string, ChannelFieldMetadata>;
}

export const CHANNEL_METADATA: Record<string, ChannelMetadata> = {
  resend: {
    nameEn: 'Resend',
    descriptionEn: 'Send event reminders via Resend email API with HTML formatting',
    fields: {
      token: {
        labelEn: 'Resend API Key',
        placeholderEn: 're_xxxxxx',
        helpText: '从 https://resend.com 获取 API Key',
      },
      webhook: {
        labelEn: 'From Email',
        placeholderEn: 'user@example.com',
        helpText: '已验证域名的发件邮箱；留空使用测试地址 onboarding@resend.dev',
      },
      chat_id: {
        labelEn: 'Recipient Emails',
        placeholderEn: 'user@example.com',
        helpText: '多个邮箱用逗号分隔；留空时使用「设置 → 通知默认邮箱」',
      },
    },
  },
  smtp: {
    nameEn: 'SMTP Email',
    descriptionEn: 'Send emails via SMTP protocol (Gmail, Outlook, self-hosted, etc.)',
    fields: {
      webhook: {
        labelEn: 'SMTP Server',
        placeholderEn: 'smtp.gmail.com',
        helpText: 'SMTP 服务器地址',
      },
      secret: {
        labelEn: 'SMTP Port',
        placeholderEn: '587',
        helpText: '通常 587 (TLS) 或 465 (SSL)',
      },
      token: {
        labelEn: 'Password / App Password',
        helpText: '邮箱密码或应用专用密码/授权码',
      },
      chat_id: {
        labelEn: 'From Email',
        placeholderEn: 'user@gmail.com',
        helpText: '发件人邮箱地址（也用作 SMTP 用户名）',
      },
    },
  },
  discord: {
    nameEn: 'Discord',
    descriptionEn: 'Send rich text messages to Discord channels',
    officialUrl: 'https://discord.com/developers/applications',
    fields: {
      webhook: {
        labelEn: 'Webhook URL',
        helpText: '在 Discord 服务器设置中创建 webhook',
      },
    },
  },
  slack: {
    nameEn: 'Slack',
    descriptionEn: 'Send messages to Slack channels with Blocks format',
    officialUrl: 'https://api.slack.com/messaging/webhooks',
    fields: {
      webhook: {
        labelEn: 'Webhook URL',
        helpText: '在 Slack 应用设置中创建 Incoming Webhook',
      },
    },
  },
  feishu: {
    nameEn: 'Feishu',
    descriptionEn: 'Send card messages to Feishu group chats',
    officialUrl: 'https://open.feishu.cn/document/ukTMukTMukTM/ucTM5YjL3ETO24yNxkjN',
    fields: {
      webhook: {
        labelEn: 'Webhook URL',
        helpText: '在飞书群聊中添加自定义机器人获取',
      },
    },
  },
  wecom: {
    nameEn: 'WeCom',
    descriptionEn: 'Send Markdown messages to WeCom group chats',
    officialUrl: 'https://developer.work.weixin.qq.com/document/path/91770',
    fields: {
      webhook: {
        labelEn: 'Webhook URL',
        helpText: '在企业微信中创建群机器人获取 webhook',
      },
    },
  },
  dingtalk: {
    nameEn: 'DingTalk',
    descriptionEn: 'Send messages to DingTalk group chats with HMAC-SHA256 signature',
    officialUrl: 'https://open.dingtalk.com/document/robot/customize-bot-notification',
    fields: {
      webhook: {
        labelEn: 'Webhook URL',
      },
      secret: {
        labelEn: 'Signing Secret',
        placeholderEn: 'SEC...',
        helpText: '在钉钉机器人安全设置中启用签名密钥',
      },
    },
  },
  googlechat: {
    nameEn: 'Google Chat',
    descriptionEn: 'Send messages to Google Chat spaces',
    officialUrl: 'https://developers.google.com/chat',
    fields: {
      webhook: {
        labelEn: 'Webhook URL',
        helpText: '在 Google Chat API 中创建 webhook',
      },
    },
  },
  telegram: {
    nameEn: 'Telegram',
    descriptionEn: 'Send messages via Telegram bot',
    officialUrl: 'https://core.telegram.org/bots',
    fields: {
      token: {
        labelEn: 'Bot Token',
        placeholderEn: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz',
        helpText: '@BotFather 创建机器人获取 token',
      },
      chat_id: {
        labelEn: 'Chat ID',
        placeholderEn: '123456789',
        helpText: '@userinfobot 获取你的 Chat ID',
      },
    },
  },
  line: {
    nameEn: 'LINE',
    descriptionEn: 'Send messages via LINE Messaging API',
    officialUrl: 'https://developers.line.biz/',
    fields: {
      token: {
        labelEn: 'Channel Access Token',
        helpText: 'LINE Messaging API 的 Channel Access Token',
      },
      chat_id: {
        labelEn: 'User ID / Group ID',
        helpText: 'LINE 开发者控制台获取的用户或群组 ID',
      },
    },
  },
  matrix: {
    nameEn: 'Matrix',
    descriptionEn: 'Send messages via Matrix protocol',
    officialUrl: 'https://matrix.org/',
    fields: {
      homeserver: {
        labelEn: 'Homeserver URL',
        placeholderEn: 'https://matrix.org',
        helpText: 'Matrix Homeserver 地址（写入 webhook 列）',
      },
      token: {
        labelEn: 'Access Token',
        placeholderEn: 'eyJ...',
      },
      roomId: {
        labelEn: 'Room ID',
        placeholderEn: '!room:matrix.org',
        helpText: '目标房间 ID（写入 chat_id 列）',
      },
    },
  },
  mattermost: {
    nameEn: 'Mattermost',
    descriptionEn: 'Send messages via Mattermost bot',
    officialUrl: 'https://docs.mattermost.com/guides/mattermost-operator-guide.html',
    fields: {
      webhook: {
        labelEn: 'Server URL',
        placeholderEn: 'https://mattermost.example.com',
      },
      token: {
        labelEn: 'Bot Access Token',
      },
      chat_id: {
        labelEn: 'Channel ID',
      },
    },
  },
  msteams: {
    nameEn: 'Microsoft Teams',
    descriptionEn: 'Send messages via Microsoft Teams bot',
    officialUrl: 'https://learn.microsoft.com/en-us/microsoftteams/platform/',
    fields: {
      token: {
        labelEn: 'Bot Framework Token',
      },
      chat_id: {
        labelEn: 'Teams Channel ID',
      },
    },
  },
  wxpusher: {
    nameEn: 'WeChat Push (WxPusher)',
    descriptionEn: 'Send messages via WxPusher WeChat notification service',
    officialUrl: 'https://wxpusher.zjiecode.com/',
    fields: {
      token: {
        labelEn: 'App Token',
        placeholderEn: 'AT_xxxxxx',
        helpText: '在 WxPusher 后台创建应用获取',
      },
      chat_id: {
        labelEn: 'User UID',
        placeholderEn: 'UID_xxxxxx',
        helpText: '用户关注后获取的 UID',
      },
    },
  },
  qmsg: {
    nameEn: 'Qmsg QQ',
    descriptionEn: 'Send messages via Qmsg QQ bot',
    officialUrl: 'https://qmsg.zendee.cn/',
    fields: {
      token: {
        labelEn: 'Key',
        placeholderEn: 'Qmsg key',
        helpText: '在 Qmsg 官网获取 key',
      },
      chat_id: {
        labelEn: 'QQ Number',
        placeholderEn: '123456789',
        helpText: '接收消息的 QQ 号',
      },
    },
  },
  irc: {
    nameEn: 'IRC',
    descriptionEn: 'Send messages to IRC via a bridge webhook (e.g. matterbridge)',
    fields: {
      webhook: {
        labelEn: 'Bridge Webhook URL',
        helpText: 'matterbridge 等 IRC 桥接 HTTP 端点（云端没有 TCP 长连接）',
      },
    },
  },
  synologychat: {
    nameEn: 'Synology Chat',
    descriptionEn: 'Send messages via Synology NAS Chat',
    fields: {
      webhook: {
        labelEn: 'Webhook URL',
        helpText: '在 Synology Chat 中创建传入 Webhook',
      },
    },
  },
  twitch: {
    nameEn: 'Twitch',
    descriptionEn: 'Send messages to Twitch via its EventSub webhook',
    fields: {
      webhook: {
        labelEn: 'EventSub Webhook URL',
        helpText: 'Twitch EventSub Webhook 地址',
      },
    },
  },
  // v2.28 batch：PushBullet / Join / PushSafer / Webex / Notifiarr
  pushbullet: {
    nameEn: 'PushBullet',
    descriptionEn: 'Cross-platform push via PushBullet',
    officialUrl: 'https://www.pushbullet.com/#settings/account',
    fields: {
      token: {
        labelEn: 'Access-Token',
        helpText: '在 PushBullet 账户设置页创建 Access Token',
      },
    },
  },
  join: {
    nameEn: 'Join',
    descriptionEn: 'Push to Android devices via Join (joaoapps)',
    officialUrl: 'https://joinjoaomgcd.appspot.com/',
    fields: {
      token: {
        labelEn: 'Api Key',
        helpText: 'Join API 页生成（joinjoaomgcd.appspot.com → Join API）',
      },
      chat_id: {
        labelEn: 'Device ID',
        helpText: '可选；目标设备 ID，留空发到全部设备',
      },
    },
  },
  pushsafer: {
    nameEn: 'PushSafer',
    descriptionEn: 'Cross-platform push via PushSafer',
    officialUrl: 'https://www.pushsafer.com/',
    fields: {
      token: {
        labelEn: 'Private Key',
        helpText: 'PushSafer 仪表盘的 Private（Alias）Key',
      },
    },
  },
  webex: {
    nameEn: 'Webex',
    descriptionEn: 'Cisco Webex Space incoming webhook',
    officialUrl: 'https://developer.webex.com/docs/webhooks-incoming',
    fields: {
      webhook: {
        labelEn: 'Incoming Webhook URL',
        helpText: 'Webex Space → Integrations → Incoming Webhook 创建',
      },
    },
  },
  notifiarr: {
    nameEn: 'Notifiarr',
    descriptionEn: 'Passthrough notifications via Notifiarr',
    officialUrl: 'https://notifiarr.com/',
    fields: {
      webhook: {
        labelEn: 'Passthrough URL',
        helpText: 'Notifiarr 自定义通知通道的完整 Passthrough URL（含 apiKey）',
      },
    },
  },
  // ============ v2.29 batch (wave4) ============
  guilded: {
    nameEn: 'Guilded',
    descriptionEn: 'Guilded server channel messages via incoming webhook',
    officialUrl: 'https://www.guilded.gg/',
    fields: {
      webhook: {
        labelEn: 'Webhook URL',
        helpText: '服务器 → 频道设置 → 集成 → Webhook 创建后复制完整 URL',
      },
    },
  },
  ifttt: {
    nameEn: 'IFTTT',
    descriptionEn: 'Trigger IFTTT Applets via Maker Webhooks',
    officialUrl: 'https://ifttt.com/maker_webhooks',
    fields: {
      token: {
        labelEn: 'Webhooks Key',
        helpText: '打开官方页面 → Documentation 标签即可看到你的 Key（可用手机扫码直达）',
      },
      webhook: {
        labelEn: 'Event Name',
        helpText: 'Applet 中 Webhooks 触发器的事件名，需与这里完全一致',
      },
    },
  },
  revolt: {
    nameEn: 'Revolt',
    descriptionEn: 'Revolt open-source chat channel messages via bot token',
    officialUrl: 'https://revolt.chat/',
    fields: {
      token: {
        labelEn: 'Bot Token',
        helpText: 'developers.revolt.chat 创建 Bot 后的 Token；把 Bot 拉进目标频道',
      },
      chat_id: {
        labelEn: 'Channel ID',
        helpText: '目标频道 ID（客户端频道设置里可复制）',
      },
    },
  },
  onesignal: {
    nameEn: 'OneSignal',
    descriptionEn: 'Cross-platform push via OneSignal REST API',
    officialUrl: 'https://onesignal.com/',
    fields: {
      token: {
        labelEn: 'REST API Key',
        helpText: 'OneSignal 后台 Settings → Keys & IDs',
      },
      secret: {
        labelEn: 'App ID',
        helpText: 'OneSignal App 的唯一 ID，同一页面可查',
      },
      chat_id: {
        labelEn: 'Subscription ID',
        helpText: '可选；留空发给全部 Subscribed Users',
      },
    },
  },
  sendgrid: {
    nameEn: 'SendGrid',
    descriptionEn: 'Transactional email via SendGrid API',
    officialUrl: 'https://sendgrid.com/',
    fields: {
      token: {
        labelEn: 'API Key',
        helpText: '需要 Mail Send 权限的 API Key',
      },
      secret: {
        labelEn: 'From Email',
        helpText: '已在 SendGrid 完成验证的发件人地址',
      },
      chat_id: {
        labelEn: 'To Email',
        helpText: '接收提醒的邮箱',
      },
    },
  },
  mailgun: {
    nameEn: 'Mailgun',
    descriptionEn: 'Transactional email via Mailgun API',
    officialUrl: 'https://www.mailgun.com/',
    fields: {
      token: {
        labelEn: 'Private API Key',
        helpText: 'Mailgun 后台 Settings → API Security',
      },
      webhook: {
        labelEn: 'Sending Domain',
        helpText: '已验证的发信域名，沙箱域名也可用',
      },
      chat_id: {
        labelEn: 'To Email',
        helpText: '接收提醒的邮箱',
      },
    },
  },
  vonage_sms: {
    nameEn: 'Vonage SMS',
    descriptionEn: 'International SMS via Vonage (Nexmo)',
    officialUrl: 'https://www.vonage.com/communications-apis/sms/',
    fields: {
      token: {
        labelEn: 'API Key',
        helpText: 'Vonage 控制台首页',
      },
      secret: {
        labelEn: 'API Secret',
        helpText: 'Vonage 控制台首页',
      },
      chat_id: {
        labelEn: 'To Phone Number',
        helpText: 'E.164 格式，含国家码不带 + 号',
      },
    },
  },
  messagebird: {
    nameEn: 'MessageBird',
    descriptionEn: 'International SMS via MessageBird',
    officialUrl: 'https://www.messagebird.com/',
    fields: {
      token: {
        labelEn: 'Access Key',
        helpText: 'Developers → API Access 的 Live Key',
      },
      chat_id: {
        labelEn: 'To Phone Number',
        helpText: 'E.164 格式，含国家码不带 + 号',
      },
    },
  },
  alertzy: {
    nameEn: 'Alertzy',
    descriptionEn: 'Mobile push via Alertzy',
    officialUrl: 'https://alertzy.app/',
    fields: {
      token: {
        labelEn: 'Account Key',
        helpText: '官网注册后 Dashboard 显示的 Account Key（手机扫码直达注册页）',
      },
    },
  },
  awtrix: {
    nameEn: 'Awtrix 3',
    descriptionEn: 'Awtrix 3 pixel clock notifications over LAN',
    officialUrl: 'https://blueforcer.github.io/awtrix3/',
    fields: {
      webhook: {
        labelEn: 'Device URL',
        helpText: '设备局域网地址（如 http://192.168.1.50），无需路径',
      },
    },
  },
};