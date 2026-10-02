import { describe, it, expect } from 'vitest';
import { readDelivery } from './delivery-outcome.js';

/**
 * 这些断言都是任务里真实发生过的故障，不是假想：
 *   - 3 个渠道成功 1 个失败时 status='success'（tasks.ts 只看 every(!success)）
 *   - 安静时段投递写出 error_message="_quiet_hours: quiet_hours"
 *   - 部分失败被重试接口按 status==='success' 挡掉，用户补不了
 */
describe('readDelivery', () => {
  it('reports a partially delivered send as partial, not success', () => {
    const report = readDelivery({
      status: 'success',
      channelResults: {
        telegram: { success: true },
        email: { success: true },
        fcm: { success: false, error: 'HTTP 500' },
      },
    });
    expect(report.outcome).toBe('partial');
    expect(report.delivered).toEqual(['telegram', 'email']);
    expect(report.failed).toEqual(['fcm']);
    expect(report.reason).toBe('fcm: HTTP 500');
  });

  it('never counts the internal marker keys as channels', () => {
    // 安静时段：2 个渠道真送出去了，_quiet_hours 只是标记，旧代码会把它算成失败渠道
    const report = readDelivery({
      status: 'success',
      channelResults: {
        telegram: { success: true },
        email: { success: true },
        _quiet_hours: { success: false, error: 'quiet_hours' },
      },
    });
    expect(report.outcome).toBe('delivered');
    expect(report.failed).toEqual([]);
    expect(report.reason).toBeUndefined();
  });

  it('treats a marker-only result as skipped, not a delivery failure', () => {
    const report = readDelivery({
      status: 'failed',
      channelResults: { _skipped: { success: false, error: 'no_supported_channels' } },
    });
    expect(report.outcome).toBe('skipped');
    expect(report.reason).toBe('no_supported_channels');
  });

  it('keeps a quiet-hours-only send distinguishable from a real failure', () => {
    const report = readDelivery({
      status: 'failed',
      channelResults: { _quiet_hours: { success: false, error: 'quiet_hours' } },
    });
    expect(report.outcome).toBe('skipped');
    expect(report.reason).toBe('quiet_hours');
  });

  it('reports an all-channel failure as failed', () => {
    const report = readDelivery({
      status: 'failed',
      channelResults: {
        telegram: { success: false, error: '401' },
        email: { success: false, error: '502' },
      },
    });
    expect(report.outcome).toBe('failed');
    expect(report.delivered).toEqual([]);
    expect(report.failed).toEqual(['telegram', 'email']);
  });

  it('passes an explicit skipped status through with its reason code', () => {
    const report = readDelivery({ status: 'skipped', errorMessage: 'no_channel_resolved' });
    expect(report.outcome).toBe('skipped');
    expect(report.reason).toBe('no_channel_resolved');
  });

  it('parses legacy TEXT channel_results that arrive as a JSON string', () => {
    const report = readDelivery({
      status: 'success',
      channelResults: JSON.stringify({ telegram: { success: true }, fcm: { success: false, error: 'boom' } }),
    });
    expect(report.outcome).toBe('partial');
    expect(report.failed).toEqual(['fcm']);
  });

  it('degrades to status when channel_results is missing or corrupt', () => {
    expect(readDelivery({ status: 'success' }).outcome).toBe('delivered');
    expect(readDelivery({ status: 'failed', errorMessage: 'db down' }).outcome).toBe('failed');
    // 坏 JSON 不能让整个提醒日志页崩掉
    expect(readDelivery({ status: 'success', channelResults: '{not json' }).outcome).toBe('delivered');
    expect(readDelivery({ status: 'success', channelResults: [1, 2, 3] }).outcome).toBe('delivered');
    expect(readDelivery({ status: 'success', channelResults: null }).outcome).toBe('delivered');
  });

  it('lists a channel with no success flag as failed rather than delivered', () => {
    // 畸形条目（缺 success）按未送达处理：宁可显示问题，也不要谎报成功
    const report = readDelivery({ status: 'success', channelResults: { telegram: {} } });
    expect(report.outcome).toBe('failed');
    expect(report.failed).toEqual(['telegram']);
  });
});