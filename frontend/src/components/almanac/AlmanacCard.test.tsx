import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AlmanacCard } from './AlmanacCard';
import { stubThrowingGetDayYi } from '@/test/throwing-lunar';

describe('AlmanacCard (plan todo 77)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the compact 今日黄历 card for a pinned date', () => {
    render(<AlmanacCard dateKey="2025-10-08" />);
    const card = screen.getByTestId('almanac-card');
    expect(card).toHaveTextContent('今日黄历');
    expect(card).toHaveTextContent('二〇二五年八月十七');
    expect(card).toHaveTextContent('乙巳 丙戌 庚戌');
    expect(card).toHaveTextContent('蛇');
    expect(card).toHaveTextContent('天秤');
    expect(screen.getByTestId('almanac-jieqi')).toHaveTextContent('今日节气：寒露');
    expect(screen.getByTestId('almanac-yi')).toHaveTextContent('祭祀');
    expect(screen.getByTestId('almanac-ji')).toHaveTextContent('动土');
    expect(screen.queryByTestId('almanac-incomplete')).not.toBeInTheDocument();
  });

  it('detail variant adds 值星, 冲煞 and 吉神方位', () => {
    render(<AlmanacCard dateKey="2025-10-08" variant="detail" />);
    const card = screen.getByTestId('almanac-card');
    expect(card).toHaveTextContent('值星');
    expect(card).toHaveTextContent('建');
    expect(card).toHaveTextContent('冲煞');
    expect(card).toHaveTextContent('(甲辰)龙');
    expect(card).toHaveTextContent('吉神方位');
    expect(card).toHaveTextContent('喜神西北');
  });

  it('a throwing library field renders the remaining fields with the 数据不完整 hint', () => {
    stubThrowingGetDayYi();

    render(<AlmanacCard dateKey="2025-10-08" />);
    const card = screen.getByTestId('almanac-card');
    // Degraded field shows a placeholder...
    expect(screen.getByTestId('almanac-yi')).toHaveTextContent('—');
    // ...while the other fields keep rendering.
    expect(card).toHaveTextContent('二〇二五年八月十七');
    expect(card).toHaveTextContent('庚戌');
    expect(screen.getByTestId('almanac-ji')).toHaveTextContent('动土');
    const hint = screen.getByTestId('almanac-incomplete');
    expect(hint).toHaveTextContent('数据不完整');
    expect(hint).toHaveTextContent('yi');
  });
});
