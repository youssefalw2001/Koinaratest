import { createRoot } from "react-dom/client";
import { setExtraHeaders, setBaseUrl } from "@workspace/api-client-react";
import "./polyfills";
import App from "./App";
import "./index.css";

const apiUrl = import.meta.env.VITE_API_URL;
if (apiUrl) {
  setBaseUrl(apiUrl);
}

const initData = window.Telegram?.WebApp?.initData ?? "";
if (initData) {
  setExtraHeaders({ "x-telegram-init-data": initData });
}

createRoot(document.getElementById("root")!).render(<App />);
