interface TelegramHapticFeedback {
  impactOccurred: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
  notificationOccurred: (type: "error" | "success" | "warning") => void;
  selectionChanged: () => void;
}

interface TelegramWebApp {
  openTelegramLink: (url: string) => void;
  openLink: (url: string) => void;
  close: () => void;
  expand: () => void;
  ready: () => void;
  initData: string;
  initDataUnsafe: {
    user?: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
      language_code?: string;
      photo_url?: string;
    };
    start_param?: string;
  };
  HapticFeedback?: TelegramHapticFeedback;
}

interface Window {
  Telegram?: {
    WebApp?: TelegramWebApp;
  };
}
