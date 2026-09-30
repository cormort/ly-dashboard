import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** 最後一道防線：任何渲染期例外都不該讓畫面全白。 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[立委觀測站] 未預期的前端錯誤', error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div className="state-block error" role="alert">
          <div>
            <b>畫面發生未預期的錯誤</b>
            <small>{error.message}</small>
          </div>
          <button type="button" onClick={this.handleReset}>
            重試
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
