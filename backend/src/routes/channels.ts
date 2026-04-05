import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { 
  allChannelTemplates, 
  getChannelTemplate, 
  getChannelsByMethod,
  type ChannelConfigMethod 
} from '../services/notifications/channels.config.js';
import type { User } from '@timemark/shared';

// Plugin service imports
import { startAuth as startWechatAuth, checkAuth as checkWechatAuth, logout as logoutWechat } from '../services/notifications/wechaty.service.js';
import { startAuth as startWhatsappAuth, checkAuth as checkWhatsappAuth, logout as logoutWhatsapp } from '../services/notifications/whatsapp.service.js';
import { startAuth as startQQAuth, checkAuth as checkQQAuth, logout as logoutQQ } from '../services/notifications/qqbot.service.js';
import { startAuth as startSignalAuth, checkAuth as checkSignalAuth, logout as logoutSignal } from '../services/notifications/signal.service.js';
import { startAuth as startZaloAuth, checkAuth as checkZaloAuth, logout as logoutZalo } from '../services/notifications/zalo.service.js';
import { startAuth as startBlueBubblesAuth, checkAuth as checkBlueBubblesAuth, logout as logoutBlueBubbles } from '../services/notifications/bluebubbles.service.js';

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

// ============ Plugin Authentication Endpoints ============

// Start plugin authentication (QR code flow)
channels.post('/plugin/:type/start-auth', async (c) => {
  const type = c.req.param('type');
  const body = await c.req.json().catch(() => ({}));
  const qqNumber = body.qqNumber;
  
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
        if (!qqNumber) {
          return c.json({ success: false, error: 'QQ号码不能为空' }, 400);
        }
        result = await startQQAuth(qqNumber);
        break;
      case 'signal':
        result = await startSignalAuth(body.phoneNumber);
        break;
      case 'zalo':
        result = await startZaloAuth(body.credentials);
        break;
      case 'imessage':
        result = await startBlueBubblesAuth(body.config);
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
  const { sessionData } = await c.req.json().catch(() => ({ sessionData: null }));
  
  if (!sessionData) {
    return c.json({ success: false, error: '缺少会话数据' }, 400);
  }
  
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
  const { sessionData } = await c.req.json().catch(() => ({ sessionData: null }));
  
  if (!sessionData) {
    return c.json({ success: false, error: '缺少会话数据' }, 400);
  }
  
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
      default:
        return c.json({ success: false, error: '不支持的插件类型' }, 400);
    }
    
    return c.json({ success: true });
  } catch (error: any) {
    console.error(`[Plugin Auth] Failed to logout for ${type}:`, error);
    return c.json({ success: false, error: error.message || '登出失败' }, 500);
  }
});

export default channels;
