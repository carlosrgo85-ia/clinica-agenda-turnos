import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./button";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Red de contención de última instancia: un error de render no debe dejar la pantalla en blanco. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Error no capturado en la UI:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <h2>Ocurrió un error inesperado</h2>
          <p className="muted">{this.state.error.message}</p>
          <Button onClick={() => this.setState({ error: null })}>Volver a intentar</Button>
        </div>
      );
    }
    return this.props.children;
  }
}
