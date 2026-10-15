import "@fontsource-variable/inter/wght.css";
import "./styles/tokens.css";
import "./styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { initTheme } from "./theme.ts";

// Before the first render, so the saved palette is on the root element when anything is drawn.
initTheme();
const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");
createRoot(root).render(<StrictMode><App /></StrictMode>);
