import { createRoot } from "react-dom/client";
import { setExtraHeaders } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

const initData = window.Telegram?.WebApp?.initData ?? "";
if (initData) {
  setExtraHeaders({ "x-telegram-init-data": initData });
}

createRoot(document.getElementById("root")!).render(<App />);
