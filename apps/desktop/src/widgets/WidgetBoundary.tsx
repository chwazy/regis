import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorMessage } from '../lib/format';
import { WidgetError } from './parts';

interface WidgetBoundaryProps {
  children: ReactNode;
}

interface WidgetBoundaryState {
  message: string | null;
}

export class WidgetBoundary extends Component<WidgetBoundaryProps, WidgetBoundaryState> {
  override state: WidgetBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): WidgetBoundaryState {
    return { message: errorMessage(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[widget] render failed:', error, info.componentStack);
  }

  override render() {
    if (this.state.message !== null) {
      return <WidgetError message={`Ce widget a rencontré une erreur : ${this.state.message}`} />;
    }
    return this.props.children;
  }
}
