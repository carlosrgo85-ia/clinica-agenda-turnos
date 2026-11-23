import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import "./components/ui/ui.css";
import "./components/shell/shell.css";
import App from "./App.tsx";
import { applyTheme, getStoredTheme } from "./components/shell/theme";

// Antes del primer render, para no parpadear entre el tema guardado y el default.
applyTheme(getStoredTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename="/app">
      <App />
    </BrowserRouter>
  </StrictMode>
);
