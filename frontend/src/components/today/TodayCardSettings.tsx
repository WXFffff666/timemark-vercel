import { useState } from 'react';
import { ChevronDown, ChevronUp, RotateCcw, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TODAY_CARD_META } from './cards';
import type { UseTodayCardsResult } from './useTodayCards';

/** Show / hide / reorder the Today cards; persisted per user by useTodayCards. */
export function TodayCardSettings({ state, toggle, move, reset }: UseTodayCardsResult) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" className="rounded-full" onClick={() => setOpen(true)}>
        <Settings2 size={16} aria-hidden /> 配置卡片
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>配置今日卡片</DialogTitle>
          </DialogHeader>
          <ul className="space-y-2">
            {state.order.map((id, index) => {
              const meta = TODAY_CARD_META[id];
              return (
                <li key={id} className="flex items-center gap-3">
                  <Switch
                    checked={!state.hidden.includes(id)}
                    onCheckedChange={() => toggle(id)}
                    aria-label={`显示${meta.title}`}
                  />
                  <span className="flex-1 text-sm font-medium text-slate-700 dark:text-slate-200">{meta.title}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-full"
                    disabled={index === 0}
                    onClick={() => move(id, -1)}
                    aria-label={`上移${meta.title}`}
                  >
                    <ChevronUp size={16} aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-full"
                    disabled={index === state.order.length - 1}
                    onClick={() => move(id, 1)}
                    aria-label={`下移${meta.title}`}
                  >
                    <ChevronDown size={16} aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>
          <Button variant="outline" className="rounded-full" onClick={reset}>
            <RotateCcw size={16} aria-hidden /> 恢复默认
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
