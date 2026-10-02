import {
  MessageCircle, MessageSquare, Mail, Webhook, Gamepad2, Hash, Building2,
  Terminal, Server, Video, Smartphone, Send, Grid3X3, Cloud, Zap, Phone,
  Shield, BookOpen, Plus, Settings, Loader2, Bell,
} from 'lucide-react';
import type { ElementType } from 'react';

/**
 * 后端渠道目录给的是 Lucide 图标名（channels.config.ts 的 `icon` 字段），这里只负责把名字
 * 变成组件。缺名字就退回传入的 fallback——渠道是可选的，缺个图标不该让整个选择器崩掉。
 */
const ICON_MAP: Record<string, ElementType> = {
  MessageCircle, MessageSquare, Mail, Webhook, Gamepad2, Hash, Building2,
  Terminal, Server, Video, Smartphone, Send, Grid3X3, Cloud, Zap, Phone,
  Shield, BookOpen, Plus, Settings, Loader2, Bell,
};

export function ChannelIcon({
  name,
  fallback = 'Bell',
  size,
  className,
}: {
  name?: string;
  fallback?: string;
  size?: number;
  className?: string;
}) {
  const Icon = (name && ICON_MAP[name]) || ICON_MAP[fallback] || MessageSquare;
  return <Icon aria-hidden="true" size={size} className={className} />;
}