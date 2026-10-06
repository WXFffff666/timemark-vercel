import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

/**
 * v2.30：页面级错误边界——此前任何页面渲染抛错都会卸载整棵 React 树，
 * 用户看到的是白屏（连导航都没了）。崩溃被限制在内容区，保留返回入口，
 * 并把错误摘要暴露给用户复制反馈。
 */
interface Props {
  children: ReactNode;
  /** 页面名，用于错误提示文案 */
  pageName?: string;
}

interface State {
  error: Error | null;
}

export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 页面崩溃必须可诊断：完整栈进 console（生产上接日志即可捞到）
    console.error('[PageErrorBoundary]', this.props.pageName ?? 'unknown', error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="min-h-[60vh] flex items-center justify-center p-6">
          <div className="glass-panel rounded-[2rem] p-8 max-w-md w-full ring-1 ring-black/5 dark:ring-white/10 text-center">
            <AlertTriangle className="w-10 h-10 mx-auto text-amber-500 mb-4" aria-hidden />
            <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-2">
              {this.props.pageName ? `「${this.props.pageName}」页面出了问题` : '页面出了问题'}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-1">
              页面渲染时发生错误，其他功能不受影响。
            </p>
            <p className="text-xs text-slate-400 font-mono break-all mb-5 select-all">
              {this.state.error.message}
            </p>
            <div className="flex gap-2 justify-center">
              <button
                type="button"
                onClick={this.reset}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary-500 text-white text-sm font-semibold hover:bg-primary-600 transition"
              >
                <RotateCcw size={14} aria-hidden /> 重试
              </button>
              <button
                type="button"
                onClick={() => { window.location.href = '/dashboard'; }}
                className="px-4 py-2 rounded-full border border-slate-300 dark:border-slate-600 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              >
                回首页
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
