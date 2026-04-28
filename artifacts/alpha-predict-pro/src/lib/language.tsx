import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type AppLanguage = "en" | "hi" | "ar";

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
  | "hindi"
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

const en: Record<TranslationKey, string> = {
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
  hindi: "Hindi",
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
  minesBlurb: "Uncover gems to grow your multiplier. Hit a mine and you lose the stake. Cash out any time.",
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
};

const hi: Record<TranslationKey, string> = {
  appName: "कोइनारा",
  trade: "ट्रेड",
  crash: "क्रैश",
  mines: "माइंस",
  earn: "कमाएँ",
  shop: "शॉप",
  wallet: "वॉलेट",
  profile: "प्रोफाइल",
  leaderboard: "लीडरबोर्ड",
  vip: "वीआईपी",
  language: "भाषा",
  english: "अंग्रेज़ी",
  hindi: "हिंदी",
  arabic: "अरबी",
  tradeArena: "ट्रेड एरीना",
  earnCenter: "अर्न सेंटर",
  gemShop: "जेम शॉप",
  walletTitle: "कोइनारा वॉलेट",
  profileTitle: "प्रोफाइल",
  connect: "कनेक्ट करें",
  cancel: "रद्द करें",
  confirm: "पुष्टि करें",
  close: "बंद करें",
  retry: "फिर कोशिश करें",
  loading: "लोड हो रहा है...",
  balance: "बैलेंस",
  gold: "गोल्ड कॉइन्स",
  credits: "ट्रेड क्रेडिट्स",
  won: "जीत",
  lost: "हार",
  insufficient: "बैलेंस पर्याप्त नहीं है",
  ton: "TON",
  comingSoon: "जल्द आ रहा है",
  longLabel: "ऊपर",
  shortLabel: "नीचे",
  betTc: "बेट (TC)",
  placeBet: "बेट लगाएँ",
  placing: "लगाया जा रहा है...",
  round: "राउंड",
  duration: "अवधि",
  multiplier: "मल्टीप्लायर",
  liveChart: "लाइव",
  vipPayout: "वीआईपी पेआउट",
  selectPair: "पेयर चुनें",
  winPayout: "जीत का पेआउट",
  waitingRound: "राउंड खत्म होने का इंतज़ार...",
  minesGame: "माइंस",
  minesBlurb: "मल्टीप्लायर बढ़ाने के लिए जेम्स खोलें। माइन लगने पर स्टेक हार जाएगा। कभी भी कैश आउट करें।",
  gridSize: "ग्रिड",
  minesLabel: "माइंस",
  startRound: "राउंड शुरू करें",
  cashout: "कैश आउट",
  nextSafe: "अगली सुरक्षित टाइल",
  busted: "बस्ट",
  cashedOut: "कैश आउट हो गया",
  newRound: "नया राउंड",
  verifyRound: "इस राउंड को सत्यापित करें",
  provablyFair: "साबित करने योग्य निष्पक्ष · क्लाइंट सीड",
  exchange: "एक्सचेंज",
  exchangeBlurb: "गोल्ड कॉइन्स को ट्रेड क्रेडिट्स में बदलें, या TON से TC पैक खरीदें।",
  gcToTc: "GC → TC",
  buyTcTon: "TC खरीदें · TON",
  gcToSpend: "खर्च करने के लिए GC",
  youReceive: "आपको मिलेगा",
  convert: "कन्वर्ट करें",
  converting: "कन्वर्ट हो रहा है...",
  rate: "रेट",
  minimum: "न्यूनतम",
  maximum: "अधिकतम",
  starterPack: "स्टार्टर पैक",
  traderPack: "ट्रेडर पैक",
  whalePack: "व्हेल पैक",
  jumboPack: "जंबो वॉल्ट",
  buy: "खरीदें",
  confirmingTx: "कन्फर्म हो रहा है...",
  tradeCredits: "ट्रेड क्रेडिट्स",
  lootbox: "लूटबॉक्स",
  lootboxBlurb: "TC/GC रोल स्पिन करें, या रेयर रिवॉर्ड्स के लिए मेगा बॉक्स पर किस्मत आज़माएँ।",
  basicTier: "बेसिक",
  proTier: "प्रो",
  megaTier: "मेगा",
  openLootbox: "लूटबॉक्स खोलें",
  lootResult: "लूट रिज़ल्ट",
  cost: "लागत",
};

const ar: Record<TranslationKey, string> = {
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
  hindi: "الهندية",
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
  minesBlurb: "اكشف الجواهر لزيادة المضاعف. إذا ضربت لغماً تخسر الرهان. يمكنك السحب في أي وقت.",
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
  exchangeBlurb: "حوّل العملات الذهبية إلى أرصدة تداول، أو اشترِ حزم TC مقابل عملة TON.",
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
};

const translations: Record<AppLanguage, Record<TranslationKey, string>> = { en, hi, ar };

interface LanguageContextShape {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  toggleLanguage: () => void;
  isArabic: boolean;
  isHindi: boolean;
  t: (key: TranslationKey) => string;
}

const LanguageContext = createContext<LanguageContextShape | null>(null);

function readStoredLanguage(): AppLanguage {
  try {
    const stored = localStorage.getItem("koinara.language");
    return stored === "ar" || stored === "hi" || stored === "en" ? stored : "en";
  } catch {
    return "en";
  }
}

function nextLanguage(current: AppLanguage): AppLanguage {
  if (current === "en") return "hi";
  if (current === "hi") return "ar";
  return "en";
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<AppLanguage>(readStoredLanguage);

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
      toggleLanguage: () => setLanguage((prev) => nextLanguage(prev)),
      isArabic: language === "ar",
      isHindi: language === "hi",
      t: (key: TranslationKey) => translations[language][key] ?? translations.en[key],
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
