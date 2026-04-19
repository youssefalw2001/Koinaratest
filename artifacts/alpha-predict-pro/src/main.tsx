import { createRoot } from "react-dom/client";
import { Buffer } from "buffer";
import { setExtraHeaders } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

if (typeof (globalThis as { Buffer?: typeof Buffer }).Buffer === "undefined") {
  (globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
}

const initData = window.Telegram?.WebApp?.initData ?? "";
if (initData) {
  setExtraHeaders({ "x-telegram-init-data": initData });
}

createRoot(document.getElementById("root")!).render(<App />);
