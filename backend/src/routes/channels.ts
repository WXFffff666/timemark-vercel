import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { 
  allChannelTemplates, 
  getChannelTemplate, 
  getChannelsByMethod,
  type ChannelConfigMethod 
} from '../services/notifications/channels.config.js';
import { testConnectionSchema, pluginStartAuthSchema, pluginCheckAuthSchema } from '@timemark/shared';
import type { User } from '@timemark/shared';
import { query } from '../db/index.js';

// Plugin service imports
import { startAuth as startWechatAuth, checkAuth as checkWechatAuth, logout as logoutWechat } from '../services/notifications/wechaty.service.js';
import { startAuth as startWhatsappAuth, checkAuth as checkWhatsappAuth, logout as logoutWhatsapp } from '../services/notifications/whatsapp.service.js';
import { startAuth as startQQAuth, checkAuth as checkQQAuth, logout as logoutQQ } from '../services/notifications/qqbot.service.js';
import { startAuth as startSignalAuth, checkAuth as checkSignalAuth, logout as logoutSignal } from '../services/notifications/signal.service.js';
import { startAuth as startZaloAuth, checkAuth as checkZaloAuth, logout as logoutZalo } from '../services/notifications/zalo.service.js';
import { startAuth as startBlueBubblesAuth, checkAuth as checkBlueBubblesAuth, logout as logoutBlueBubbles } from '../services/notifications/bluebubbles.service.js';
import { startAuth as startClawBotAuth, checkAuth as checkClawBotAuth, logout as logoutClawBot, getConnectionStatus as getClawBotConnectionStatus } from '../services/notifications/clawbot.service.js';
import { getConnectionStatus as getOpenClawConnectionStatus } from '../services/notifications/wechat-openclaw.service.js';
import { testConnection } from '../services/notifications/test-connection.js';
import { checkAllChannels, checkChannel } from '../services/notifications/network-check.js';

const channels = new Hono<{ Variables: { user: User } }>();

channels.use('*', authMiddleware);

// 获取所有渠道模板
channels.get('/templates', async (c) => {
  return c.json({ 
    success: true, 
    data: allChannelTemplates 
  });
});

// 按配置方式获取渠道模板
channels.get('/templates/:method', async (c) => {
  const method = c.req.param('method') as ChannelConfigMethod;
  
  if (!['webhook', 'token', 'plugin'].includes(method)) {
    return c.json({ 
      success: false, 
      error: 'Invalid method. Use webhook, token, or plugin' 
    }, 400);
  }
  
  const templates = getChannelsByMethod(method);
  return c.json({ 
    success: true, 
    data: templates 
  });
});

// 获取单个渠道模板详情
channels.get('/template/:id', async (c) => {
  const id = c.req.param('id');
  const template = getChannelTemplate(id);
  
  if (!template) {
    return c.json({ 
      success: false, 
      error: 'Channel template not found' 
    }, 404);
  }
  
  return c.json({ 
    success: true, 
    data: template 
  });
});

// Get available (configured + active) channels for the current user
channels.get('/available', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);

  const result = await query(
    'SELECT id, type, name, config_method, is_active, last_test_result, last_test_at, connection_status FROM notification_accounts WHERE user_id = $1 AND is_active = TRUE',
    [userId]
  );

  return c.json({
    success: true,
    data: result.rows
  });
});

// ============ Plugin Authentication Endpoints ============

// Start plugin authentication (QR code flow)
channels.post('/plugin/:type/start-auth', async (c) => {
  const type = c.req.param('type');
  const body = await c.req.json().catch(() => ({}));
  
  const parsed = pluginStartAuthSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  
  try {
    let result: { qrcode: string; sessionId: string };
    
    switch (type) {
      case 'wechat_personal':
        result = await startWechatAuth();
        break;
      case 'whatsapp':
        result = await startWhatsappAuth();
        break;
      case 'qq_bot':
        if (!parsed.data.qqNumber) {
          return c.json({ success: false, error: 'QQ号码不能为空' }, 400);
        }
        result = await startQQAuth(parsed.data.qqNumber);
        break;
      case 'signal':
        result = await startSignalAuth(parsed.data.phoneNumber || '');
        break;
      case 'zalo':
        result = await startZaloAuth(parsed.data.credentials);
        break;
      case 'imessage':
        result = await startBlueBubblesAuth(parsed.data.config);
        break;
      case 'clawbot':
        result = await startClawBotAuth();
        break;
      default:
        return c.json({ success: false, error: '不支持的插件类型' }, 400);
    }
    
    return c.json({ success: true, data: result });
  } catch (error: any) {
    console.error(`[Plugin Auth] Failed to start auth for ${type}:`, error);
    return c.json({ success: false, error: error.message || '认证启动失败' }, 500);
  }
});

// Check plugin authentication status
channels.post('/plugin/:type/check-auth', async (c) => {
  const type = c.req.param('type');
  const body = await c.req.json().catch(() => ({}));
  
  const parsed = pluginCheckAuthSchema.safeParse(body);
  if (!parsed.success || !parsed.data.sessionData) {
    return c.json({ success: false, error: '缺少会话数据' }, 400);
  }
  
  const { sessionData } = parsed.data;
  
  try {
    let result: { authenticated: boolean; user?: string };
    
    switch (type) {
      case 'wechat_personal':
        result = await checkWechatAuth(sessionData);
        break;
      case 'whatsapp':
        result = await checkWhatsappAuth(sessionData);
        break;
      case 'qq_bot':
        result = await checkQQAuth(sessionData);
        break;
      case 'signal':
        result = await checkSignalAuth(sessionData);
        break;
      case 'zalo':
        result = await checkZaloAuth(sessionData);
        break;
      case 'imessage':
        result = await checkBlueBubblesAuth(sessionData);
        break;
      case 'clawbot':
        result = await checkClawBotAuth(sessionData);
        break;
      default:
        return c.json({ success: false, error: '不支持的插件类型' }, 400);
    }
    
    return c.json({ success: true, data: result });
  } catch (error: any) {
    console.error(`[Plugin Auth] Failed to check auth for ${type}:`, error);
    return c.json({ success: false, error: error.message || '认证检查失败' }, 500);
  }
});

// Logout plugin session
channels.delete('/plugin/:type/logout', async (c) => {
  const type = c.req.param('type');
  const body = await c.req.json().catch(() => ({}));
  
  const logoutParsed = pluginCheckAuthSchema.safeParse(body);
  if (!logoutParsed.success || !logoutParsed.data.sessionData) {
    return c.json({ success: false, error: '缺少会话数据' }, 400);
  }
  
  const { sessionData } = logoutParsed.data;
  
  try {
    switch (type) {
      case 'wechat_personal':
        await logoutWechat(sessionData);
        break;
      case 'whatsapp':
        await logoutWhatsapp(sessionData);
        break;
      case 'qq_bot':
        await logoutQQ(sessionData);
        break;
      case 'signal':
        await logoutSignal(sessionData);
        break;
      case 'zalo':
        await logoutZalo(sessionData);
        break;
      case 'imessage':
        await logoutBlueBubbles(sessionData);
        break;
      case 'clawbot':
        await logoutClawBot(sessionData);
        break;
      default:
        return c.json({ success: false, error: '不支持的插件类型' }, 400);
    }
    
    return c.json({ success: true });
  } catch (error: any) {
    console.error(`[Plugin Auth] Failed to logout for ${type}:`, error);
    return c.json({ success: false, error: error.message || '登出失败' }, 500);
  }
});

// Test connection
channels.post('/test', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  
  const parsed = testConnectionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  
  // Optional accountId to update test result in DB
  const accountId = typeof body.accountId === 'number' ? body.accountId : null;
  
  try {
    const result = await testConnection({
      type: parsed.data.type,
      configMethod: parsed.data.configMethod || 'webhook',
      webhook: parsed.data.webhook || undefined,
      token: parsed.data.token || undefined,
      chatId: parsed.data.chatId || undefined,
      secret: parsed.data.secret || undefined,
      sessionData: parsed.data.sessionData
    });
    
    // Update last_test_result in DB if accountId provided
    if (accountId) {
      const testResult = result.success ? 'success' : 'failed';
      await query(
        "UPDATE notification_accounts SET last_test_result = $1, last_test_at = CURRENT_TIMESTAMP WHERE id = $2",
        [testResult, accountId]
      );
    }
    
    return c.json({ 
      success: true, 
      data: {
        success: result.success, 
        message: result.message,
        details: result.details
      }
    });
  } catch (error: any) {
    console.error('[TestConnection] Failed:', error);
    
    // Update last_test_result as failed if accountId provided
    if (accountId) {
      try {
        await query(
          "UPDATE notification_accounts SET last_test_result = $1, last_test_at = CURRENT_TIMESTAMP WHERE id = $2",
          ['failed', accountId]
        );
      } catch (dbError) {
        console.error('[TestConnection] Failed to update test result:', dbError);
      }
    }
    
    return c.json({ 
      success: false, 
      error: error.message || '测试连接失败' 
    }, 500);
  }
});

// Get connection status for a specific notification account
channels.get('/status/:accountId', async (c) => {
  const accountId = parseInt(c.req.param('accountId'), 10);
  if (isNaN(accountId)) {
    return c.json({ success: false, error: 'Invalid account ID' }, 400);
  }

  try {
    // Try ClawBot first, then OpenClaw
    let status = await getClawBotConnectionStatus(accountId);
    if (status === null) {
      status = await getOpenClawConnectionStatus(accountId);
    }

    return c.json({
      success: true,
      data: { accountId, connection_status: status }
    });
  } catch (error: any) {
    console.error(`[Channels] Failed to get connection status for account ${accountId}:`, error);
    return c.json({ success: false, error: error.message || '获取连接状态失败' }, 500);
  }
});

// ============ Network Reachability Check ============

// GET /network-check - 检测所有渠道网络可达性
channels.get('/network-check', async (c) => {
  const results = await checkAllChannels();
  return c.json({ success: true, data: results });
});

// GET /network-check/:channel - 检测单个渠道
channels.get('/network-check/:channel', async (c) => {
  const channel = c.req.param('channel');
  const result = await checkChannel(channel);
  return c.json({ success: true, data: result });
});

export default channels;
