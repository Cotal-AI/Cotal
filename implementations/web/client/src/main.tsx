import "@fontsource-variable/inter/wght.css";
import "./styles/tokens.css";
import "./styles/shadcn.css";
import "./styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");
createRoot(root).render(<StrictMode><App /></StrictMode>);
