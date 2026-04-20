import { Component, ReactNode, ErrorInfo } from "react";
import { AlertTriangle } from "lucide-react";

interface Props { children: ReactNode; }
interface State { error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught React error:", error);
    console.error("[ErrorBoundary] Component stack:", info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-black p-8 text-center">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center mb-4 border border-[#ff2d78]/40"
            style={{ background: "rgba(255,45,120,0.1)", boxShadow: "0 0 30px rgba(255,45,120,0.2)" }}
          >
            <AlertTriangle size={28} className="text-[#ff2d78]" />
          </div>
          <h1 className="font-mono text-lg font-black text-white mb-2">Something went wrong</h1>
          <p className="font-mono text-xs text-white/40 mb-1 max-w-xs break-all">
            {this.state.error.message}
          </p>
          <p className="font-mono text-[10px] text-white/20 mb-6">Check the console for the full stack trace</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="font-mono text-xs text-[#00f0ff] border border-[#00f0ff]/30 px-5 py-2.5 rounded-xl hover:bg-[#00f0ff]/5 transition-colors"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
