/**
 * 从 DATABASE_URL 主机名推断数据库大致地理区域（不暴露完整连接串）
 */
export function inferDatabaseRegionHint(databaseUrl: string | undefined): string {
  if (!databaseUrl) return 'unknown';
  const hostMatch = databaseUrl.match(/@([^/?:]+)/);
  const host = (hostMatch?.[1] || '').toLowerCase();
  if (!host) return 'unknown';

  if (/ap-east-1|hongkong|hkg|\.hk\./i.test(host)) return 'ap-east-1 (香港)';
  if (/ap-southeast-1|singapore|\.sg\.|sin1/i.test(host)) return 'ap-southeast-1 (新加坡)';
  if (/ap-northeast-1|tokyo|hnd1/i.test(host)) return 'ap-northeast-1 (东京)';
  if (/ap-northeast-2|seoul|icn1/i.test(host)) return 'ap-northeast-2 (首尔)';
  if (/ap-south-1|mumbai|bom1/i.test(host)) return 'ap-south-1 (孟买)';
  if (/us-east-1|us-east-2|iad1|cle1|virginia|ohio/i.test(host)) return 'us-east (美国东岸)';
  if (/us-west|sfo1|pdx1|oregon|california/i.test(host)) return 'us-west (美国西岸)';
  if (/eu-|europe|frankfurt|dublin|london|paris/i.test(host)) return 'eu (欧洲)';

  return `other (${host.split('.').slice(-2).join('.') || 'host'})`;
}

/** 离中国大陆用户较近的 Vercel 函数区域（优先级从高到低） */
export const PREFERRED_CN_VERCEL_REGIONS = ['hkg1', 'sin1', 'icn1', 'hnd1'] as const;

export function isPreferredCnVercelRegion(region: string | undefined): boolean {
  if (!region) return false;
  return (PREFERRED_CN_VERCEL_REGIONS as readonly string[]).includes(region);
}
