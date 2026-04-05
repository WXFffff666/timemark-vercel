import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { 
  allChannelTemplates, 
  getChannelTemplate, 
  getChannelsByMethod,
  type ChannelConfigMethod 
} from '../services/notifications/channels.config.js';
import type { User } from '@timemark/shared';

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

export default channels;
