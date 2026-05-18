import { Component, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Global React error boundary. Catches render errors and displays a
 * recovery UI instead of crashing the entire dashboard.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[Dashboard ErrorBoundary]', error, info.componentStack);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div
          style={{
            padding: '2rem',
            textAlign: 'center',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <h2 style={{ color: '#e53e3e' }}>Dashboard Error</h2>
          <p style={{ color: '#718096' }}>
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <button
            onClick={this.handleRetry}
            style={{
              marginTop: '1rem',
              padding: '0.5rem 1.5rem',
              border: '1px solid #cbd5e0',
              borderRadius: '0.375rem',
              background: '#fff',
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
