import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ALMANAC_DISCLAIMER, AlmanacAdvancedPanel } from './AlmanacAdvancedPanel';

/**
 * Panel acceptance (plan todo 150):
 * - the 传统文化参考 disclaimer is VISIBLE DOM text;
 * - a pinned 择日 range returns the pinned dates;
 * - an out-of-range year degrades to 数据不可用 (never throws);
 * - a malformed birth input is rejected with a message and never renders NaN.
 */

function setDate(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('AlmanacAdvancedPanel (plan todo 150)', () => {
  it('renders the 传统文化参考 disclaimer as visible DOM text', () => {
    render(<AlmanacAdvancedPanel />);
    const disclaimer = screen.getByTestId('almanac-disclaimer');
    expect(disclaimer).toBeVisible();
    expect(disclaimer).toHaveTextContent(ALMANAC_DISCLAIMER);
    expect(disclaimer).toHaveTextContent('传统文化参考，非决策建议');
    // Four sections are present.
    expect(screen.getByTestId('almanac-auspicious')).toBeInTheDocument();
    expect(screen.getByTestId('almanac-bazi')).toBeInTheDocument();
    expect(screen.getByTestId('almanac-daily')).toBeInTheDocument();
  });

  it('returns the pinned 嫁娶 dates for 2025-10-01..2025-10-10', () => {
    render(<AlmanacAdvancedPanel />);
    setDate('开始日期', '2025-10-01');
    setDate('结束日期', '2025-10-10');
    fireEvent.change(screen.getByLabelText('用途'), { target: { value: '嫁娶' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    const results = screen.getByTestId('auspicious-results');
    expect(results).toHaveTextContent('2025-10-02');
    expect(results).toHaveTextContent('2025-10-03');
    expect(results).toHaveTextContent('2025-10-08');
    expect(results).toHaveTextContent('已扫描 10 天');
    expect(screen.queryByTestId('auspicious-error')).not.toBeInTheDocument();
  });

  it('degrades an out-of-range 择日 year to 数据不可用', () => {
    render(<AlmanacAdvancedPanel />);
    setDate('开始日期', '1800-01-01');
    setDate('结束日期', '1800-01-31');
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    expect(screen.getByTestId('auspicious-error')).toHaveTextContent('数据不可用');
    expect(screen.queryByTestId('auspicious-results')).not.toBeInTheDocument();
  });

  it('renders pinned 八字 pillars for 2000-01-15 08:30', () => {
    render(<AlmanacAdvancedPanel />);
    fireEvent.change(screen.getByLabelText('出生时间'), { target: { value: '2000-01-15 08:30' } });
    fireEvent.click(screen.getByRole('button', { name: '排盘' }));

    const result = screen.getByTestId('bazi-result');
    expect(result).toHaveTextContent('己卯');
    expect(result).toHaveTextContent('丁丑');
    expect(result).toHaveTextContent('壬申');
    expect(result).toHaveTextContent('甲辰');
    expect(result).toHaveTextContent('日主 壬');
  });

  it('rejects a malformed birth input with a message and never renders NaN', () => {
    render(<AlmanacAdvancedPanel />);
    fireEvent.change(screen.getByLabelText('出生时间'), { target: { value: 'abc-not-a-date' } });
    fireEvent.click(screen.getByRole('button', { name: '排盘' }));

    expect(screen.getByTestId('bazi-error')).toHaveTextContent('出生时间格式无效');
    expect(screen.queryByTestId('bazi-result')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('NaN');
  });

  it('renders the 生肖/星座/彭祖/吉神 detail for a pinned date and degrades out-of-range', () => {
    render(<AlmanacAdvancedPanel />);
    setDate('参考日期', '2025-10-08');

    const daily = screen.getByTestId('daily-result');
    expect(daily).toHaveTextContent('庚不经络织机虚张');
    expect(daily).toHaveTextContent('天马');
    expect(daily).toHaveTextContent('喜神西北');
    expect(screen.getByTestId('daily-zodiac')).toHaveTextContent('蛇');
    expect(screen.getByTestId('daily-constellation')).toHaveTextContent('天秤');

    setDate('参考日期', '1800-01-01');
    expect(screen.getByTestId('daily-error')).toHaveTextContent('数据不可用');
    expect(screen.queryByTestId('daily-result')).not.toBeInTheDocument();
  });
});
