import { createRoot } from "react-dom/client";
import { Buffer } from "buffer";
import { setExtraHeaders, setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

if (typeof (globalThis as { Buffer?: typeof Buffer }).Buffer === "undefined") {
  (globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
}

const apiUrl = import.meta.env.VITE_API_URL;
if (apiUrl) {
  setBaseUrl(apiUrl);
}

const initData = window.Telegram?.WebApp?.initData ?? "";
if (initData) {
  setExtraHeaders({ "x-telegram-init-data": initData });
}

createRoot(document.getElementById("root")!).render(<App />);
