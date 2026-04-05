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
    configFields: ConfigField[];
    pluginPackage?: string;
    docUrl?: string;
    officialUrl?: string;
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
export declare const channelCategories: {
    readonly im: {
        readonly name: "即时通讯";
        readonly nameEn: "Instant Messaging";
    };
    readonly email: {
        readonly name: "邮件";
        readonly nameEn: "Email";
    };
    readonly webhook: {
        readonly name: "Webhook";
        readonly nameEn: "Webhook";
    };
    readonly plugin: {
        readonly name: "插件渠道";
        readonly nameEn: "Plugin Channels";
    };
};
export declare const channels: ChannelDefinition[];
export declare function getAllChannels(): ChannelDefinition[];
export declare function getChannelById(id: string): ChannelDefinition | undefined;
export declare function getChannelsByMethod(method: ConfigMethod): ChannelDefinition[];
export declare function getBundledChannels(): ChannelDefinition[];
export declare function getPluginChannels(): ChannelDefinition[];
