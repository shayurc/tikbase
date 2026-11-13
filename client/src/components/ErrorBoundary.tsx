import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Changing this clears a caught error — pass the current route. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

// There was no error boundary anywhere, so one exception during render — a
// malformed value in a single row is enough — unmounted the whole tree and
// left a blank dark page with nothing to click. This keeps the failure to the
// page that had it: the sidebar and search stay up, and moving to another page
// clears it.
//
// A class because React has no hook for catching render errors.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page crashed:', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="p-5 md:p-8 max-w-xl" role="alert" data-testid="page-crashed">
        <h1 className="text-xl font-semibold text-foreground mb-2">This page hit a problem</h1>
        <p className="text-sm text-muted-foreground mb-4">
          Something on this page could not be shown. It is a fault on our side, not something you did.
          The rest of TikBase still works.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="h-9 px-4 rounded-md text-xs font-bold bg-primary text-primary-foreground"
          data-testid="btn-reload-page"
        >
          Reload
        </button>
      </div>
    );
  }
}
