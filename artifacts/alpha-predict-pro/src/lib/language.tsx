import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type AppLanguage = "en" | "ar";

type TranslationKey =
  // App / nav
  | "appName"
  | "trade"
  | "crash"
  | "mines"
  | "earn"
  | "shop"
  | "wallet"
  | "profile"
  | "leaderboard"
  | "vip"
  | "language"
  | "english"
  | "arabic"
  | "tradeArena"
  | "earnCenter"
  | "gemShop"
  | "walletTitle"
  | "profileTitle"
  // Shared controls
  | "connect"
  | "cancel"
  | "confirm"
  | "close"
  | "retry"
  | "loading"
  | "balance"
  | "gold"
  | "credits"
  | "won"
  | "lost"
  | "insufficient"
  | "ton"
  | "comingSoon"
  // Terminal / trading
  | "longLabel"
  | "shortLabel"
  | "betTc"
  | "placeBet"
  | "placing"
  | "round"
  | "duration"
  | "multiplier"
  | "liveChart"
  | "vipPayout"
  | "selectPair"
  | "winPayout"
  | "waitingRound"
  // Mines
  | "minesGame"
  | "minesBlurb"
  | "gridSize"
  | "minesLabel"
  | "startRound"
  | "cashout"
  | "nextSafe"
  | "busted"
  | "cashedOut"
  | "newRound"
  | "verifyRound"
  | "provablyFair"
  // Exchange
  | "exchange"
  | "exchangeBlurb"
  | "gcToTc"
  | "buyTcTon"
  | "gcToSpend"
  | "youReceive"
  | "convert"
  | "converting"
  | "rate"
  | "minimum"
  | "maximum"
  | "starterPack"
  | "traderPack"
  | "whalePack"
  | "jumboPack"
  | "buy"
  | "confirmingTx"
  // Lootbox
  | "lootbox"
  | "lootboxBlurb"
  | "basicTier"
  | "proTier"
  | "megaTier"
  | "openLootbox"
  | "lootResult"
  | "cost"
  | "tradeCredits";

const translations: Record<AppLanguage, Record<TranslationKey, string>> = {
  en: {
    appName: "KOINARA",
    trade: "Trade",
    crash: "Crash",
    mines: "Mines",
    earn: "Earn",
    shop: "Shop",
    wallet: "Wallet",
    profile: "Profile",
    leaderboard: "Leaderboard",
    vip: "VIP",
    language: "Language",
    english: "English",
    arabic: "Arabic",
    tradeArena: "Trade Arena",
    earnCenter: "Earn Center",
    gemShop: "Gem Shop",
    walletTitle: "Koinara Wallet",
    profileTitle: "Profile",

    connect: "Connect",
    cancel: "Cancel",
    confirm: "Confirm",
    close: "Close",
    retry: "Retry",
    loading: "Loading...",
    balance: "Balance",
    gold: "Gold Coins",
    credits: "Trade Credits",
    won: "Won",
    lost: "Lost",
    insufficient: "Insufficient balance",
    ton: "TON",
    comingSoon: "Coming soon",

    longLabel: "LONG",
    shortLabel: "SHORT",
    betTc: "Bet (TC)",
    placeBet: "Place Bet",
    placing: "Placing...",
    round: "Round",
    duration: "Duration",
    multiplier: "Multiplier",
    liveChart: "LIVE",
    vipPayout: "VIP payout",
    selectPair: "Select pair",
    winPayout: "Win payout",
    waitingRound: "Waiting for round to finish...",

    minesGame: "Mines",
    minesBlurb:
      "Uncover gems to grow your multiplier. Hit a mine and you lose the stake. Cash out any time.",
    gridSize: "Grid",
    minesLabel: "Mines",
    startRound: "Start Round",
    cashout: "Cash Out",
    nextSafe: "Next safe",
    busted: "Busted",
    cashedOut: "Cashed Out",
    newRound: "New Round",
    verifyRound: "Verify this round",
    provablyFair: "Provably fair · client seed",

    exchange: "Exchange",
    exchangeBlurb: "Convert Gold Coins to Trade Credits, or buy TC packs with TON.",
    gcToTc: "GC → TC",
    buyTcTon: "Buy TC · TON",
    gcToSpend: "GC to spend",
    youReceive: "You receive",
    convert: "Convert",
    converting: "Converting...",
    rate: "Rate",
    minimum: "min",
    maximum: "max",
    starterPack: "Starter Pack",
    traderPack: "Trader Pack",
    whalePack: "Whale Pack",
    jumboPack: "Jumbo Vault",
    buy: "Buy",
    confirmingTx: "Confirming...",
    tradeCredits: "Trade Credits",

    lootbox: "Lootbox",
    lootboxBlurb: "Spin TC/GC rolls, or push your luck on a Mega box for rare rewards.",
    basicTier: "Basic",
    proTier: "Pro",
    megaTier: "Mega",
    openLootbox: "Open Lootbox",
    lootResult: "Loot Result",
    cost: "Cost",
  },
  ar: {
    appName: "كوينارا",
    trade: "تداول",
    crash: "كراش",
    mines: "الألغام",
    earn: "اكسب",
    shop: "المتجر",
    wallet: "المحفظة",
    profile: "الملف",
    leaderboard: "المتصدرين",
    vip: "النخبة",
    language: "اللغة",
    english: "الإنجليزية",
    arabic: "العربية",
    tradeArena: "ساحة التداول",
    earnCenter: "مركز المكافآت",
    gemShop: "متجر التعزيزات",
    walletTitle: "محفظة كوينارا",
    profileTitle: "الملف الشخصي",

    connect: "اتصال",
    cancel: "إلغاء",
    confirm: "تأكيد",
    close: "إغلاق",
    retry: "إعادة المحاولة",
    loading: "جاري التحميل...",
    balance: "الرصيد",
    gold: "العملات الذهبية",
    credits: "أرصدة التداول",
    won: "فوز",
    lost: "خسارة",
    insufficient: "الرصيد غير كافٍ",
    ton: "TON",
    comingSoon: "قريباً",

    longLabel: "شراء",
    shortLabel: "بيع",
    betTc: "الرهان (TC)",
    placeBet: "ضع الرهان",
    placing: "جاري التنفيذ...",
    round: "الجولة",
    duration: "المدة",
    multiplier: "المضاعف",
    liveChart: "مباشر",
    vipPayout: "عائد النخبة",
    selectPair: "اختر الزوج",
    winPayout: "عائد الفوز",
    waitingRound: "بانتظار انتهاء الجولة...",

    minesGame: "لعبة الألغام",
    minesBlurb:
      "اكشف الجواهر لزيادة المضاعف. إذا ضربت لغماً تخسر الرهان. يمكنك السحب في أي وقت.",
    gridSize: "الشبكة",
    minesLabel: "الألغام",
    startRound: "ابدأ الجولة",
    cashout: "اسحب الأرباح",
    nextSafe: "الخانة الآمنة التالية",
    busted: "انفجار",
    cashedOut: "تم السحب",
    newRound: "جولة جديدة",
    verifyRound: "تحقق من هذه الجولة",
    provablyFair: "عدل قابل للإثبات · بذرة العميل",

    exchange: "التبديل",
    exchangeBlurb:
      "حوّل العملات الذهبية إلى أرصدة تداول، أو اشترِ حزم TC مقابل عملة TON.",
    gcToTc: "GC → TC",
    buyTcTon: "شراء TC · TON",
    gcToSpend: "كمية GC للإنفاق",
    youReceive: "ستحصل على",
    convert: "تحويل",
    converting: "جاري التحويل...",
    rate: "السعر",
    minimum: "الحد الأدنى",
    maximum: "الحد الأقصى",
    starterPack: "حزمة البداية",
    traderPack: "حزمة المتداول",
    whalePack: "حزمة الحوت",
    jumboPack: "الخزينة الكبرى",
    buy: "شراء",
    confirmingTx: "جاري التأكيد...",
    tradeCredits: "أرصدة التداول",

    lootbox: "صندوق الحظ",
    lootboxBlurb: "جرّب حظك بصناديق TC/GC، أو ارفع السقف بصندوق ميجا لمكافآت نادرة.",
    basicTier: "أساسي",
    proTier: "محترف",
    megaTier: "ميجا",
    openLootbox: "افتح الصندوق",
    lootResult: "نتيجة الصندوق",
    cost: "التكلفة",
  },
};

interface LanguageContextShape {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  toggleLanguage: () => void;
  isArabic: boolean;
  t: (key: TranslationKey) => string;
}

const LanguageContext = createContext<LanguageContextShape | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<AppLanguage>(() => {
    try {
      const stored = localStorage.getItem("koinara.language");
      return stored === "ar" ? "ar" : "en";
    } catch {
      return "en";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("koinara.language", language);
    } catch {
      // no-op
    }
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  }, [language]);

  const value = useMemo<LanguageContextShape>(() => {
    return {
      language,
      setLanguage,
      toggleLanguage: () => setLanguage((prev) => (prev === "en" ? "ar" : "en")),
      isArabic: language === "ar",
      t: (key: TranslationKey) => translations[language][key],
    };
  }, [language]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error("useLanguage must be used inside LanguageProvider");
  }
  return ctx;
}
