import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";

/** A fault in one screen must never leave the customer with a blank page. */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("claimwise screen error", error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="grid min-h-screen place-items-center p-6">
        <div className="card max-w-md p-8 text-center" role="alert">
          <h1 className="text-xl font-bold">
            Something went wrong on this screen
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            Reload the workspace to continue.
          </p>
          <button
            className="btn btn-primary mx-auto mt-6"
            onClick={() => location.reload()}
          >
            Reload the workspace
          </button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <Boundary>
    <App />
  </Boundary>,
);
