import { api } from './api';

/**
 * 通知渠道目录的单一真相源是后端 channels.config.ts（docs/CHANNEL_MATRIX.md 也由它生成）。
 * 前端曾经另抄了一份 40 项的清单，于是 generic_webhook / pushdeer / twilio 在事件表单里
 * 根本选不到，web_push 之类新增渠道也要再改一次前端。
 *
 * 现在这里只做一件事：把后端目录取回来并共享（单飞 + 缓存），谁需要谁用。
 */
/** 与后端 channels.config.ts 的 ChannelField 对齐（字段名保持一致，别改） */
export interface ChannelField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'textarea' | 'select';
  required: boolean;
  placeholder?: string;
  description?: string;
  column?: string;
  labelEn?: string;
  placeholderEn?: string;
  helpText?: string;
}

export interface ChannelTemplate {
  id: string;
  name: string;
  description: string;
  /** Lucide 图标名，后端目录里给定 */
  icon: string;
  configMethod: 'webhook' | 'token' | 'plugin';
  isBuiltIn: boolean;
  nameEn?: string;
  /** 配置表单的字段定义，Channels 页据此渲染 */
  fields?: ChannelField[];
  docsUrl?: string;
}

/**
 * 云端可用的渠道：排除了 plugin（云端跑不了插件），且必须带 fields
 * ——没有字段定义的模板渲染不出配置表单，属于后端数据缺失，宁可别显示。
 *
 * ponytail: 这里不包含只有"能发"而没有"可配置账号"的渠道 id（`email` / `wechat` / `qq`
 * 只作为分发层的 legacy 别名存在）。老事件里存着这些值仍会照常投递，保存时也不会被抹掉，
 * 只是不再作为可点选项渲染。要让 `email` 重新出现在选择器里，得在 channels.config.ts
 * 给它一个模板，而不是在这里加特例。
 */
export type CloudChannelTemplate = Omit<ChannelTemplate, 'configMethod' | 'fields'> & {
  configMethod: 'webhook' | 'token';
  fields: ChannelField[];
};

let inflight: Promise<CloudChannelTemplate[]> | null = null;

/** 目录在一个会话里不会变，缓存即可；测试用 resetChannelTemplatesCache() 清掉。 */
export function fetchChannelTemplates(options: { refresh?: boolean } = {}): Promise<CloudChannelTemplate[]> {
  if (options.refresh || !inflight) {
    inflight = api
      .get<ChannelTemplate[]>('/channels/templates')
      .then((templates) =>
        templates.filter(
          (t): t is CloudChannelTemplate =>
            t.configMethod !== 'plugin' && Array.isArray(t.fields)
        )
      )
      .catch((error) => {
        // 缓存失败结果会让后续所有调用都拿到空目录，所以失败时把句柄清掉。
        inflight = null;
        throw error;
      });
  }
  return inflight;
}

export function resetChannelTemplatesCache(): void {
  inflight = null;
}