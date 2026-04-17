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
}

interface Window {
  Telegram?: {
    WebApp?: TelegramWebApp;
  };
}
