import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type AppLanguage = "en" | "hi" | "ar";

type TranslationKey =
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
  vip: "VIP",
  language: "भाषा",
  english: "English",
  hindi: "हिंदी",
  arabic: "अरबी",
  tradeArena: "प्रीमियम ट्रेड एरीना",
  earnCenter: "अर्निंग सेंटर",
  gemShop: "पावर-अप शॉप",
  walletTitle: "कोइनारा वॉलेट",
  profileTitle: "आपकी प्रोफाइल",
  connect: "वॉलेट कनेक्ट करें",
  cancel: "रद्द करें",
  confirm: "कन्फर्म करें",
  close: "बंद करें",
  retry: "दोबारा कोशिश करें",
  loading: "लोड हो रहा है...",
  balance: "बैलेंस",
  gold: "गोल्ड कॉइन्स",
  credits: "ट्रेड क्रेडिट्स",
  won: "जीत गए",
  lost: "हार गए",
  insufficient: "बैलेंस पर्याप्त नहीं है",
  ton: "TON",
  comingSoon: "जल्द आ रहा है",
  longLabel: "ऊपर",
  shortLabel: "नीचे",
  betTc: "बेट (TC)",
  placeBet: "ट्रेड लगाएँ",
  placing: "ट्रेड लग रही है...",
  round: "राउंड",
  duration: "समय",
  multiplier: "मल्टीप्लायर",
  liveChart: "लाइव",
  vipPayout: "VIP पेआउट",
  selectPair: "पेयर चुनें",
  winPayout: "जीत का पेआउट",
  waitingRound: "राउंड पूरा होने का इंतज़ार...",
  minesGame: "माइंस",
  minesBlurb: "सेफ टाइल खोलें, मल्टीप्लायर बढ़ाएँ और सही समय पर कैश आउट करें। माइन लगते ही स्टेक खत्म।",
  gridSize: "ग्रिड",
  minesLabel: "माइंस",
  startRound: "राउंड शुरू करें",
  cashout: "कैश आउट",
  nextSafe: "अगली सेफ टाइल",
  busted: "बस्ट",
  cashedOut: "कैश आउट पूरा",
  newRound: "नया राउंड",
  verifyRound: "राउंड वेरिफाई करें",
  provablyFair: "प्रूवेबली फेयर · क्लाइंट सीड",
  exchange: "एक्सचेंज",
  exchangeBlurb: "GC को TC में बदलें या TON से प्रीमियम TC पैक खरीदें।",
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
  confirmingTx: "पेमेंट कन्फर्म हो रही है...",
  tradeCredits: "ट्रेड क्रेडिट्स",
  lootbox: "लूटबॉक्स",
  lootboxBlurb: "TC/GC रिवार्ड रोल करें या रेयर रिवॉर्ड्स के लिए मेगा बॉक्स खोलें।",
  basicTier: "बेसिक",
  proTier: "प्रो",
  megaTier: "मेगा",
  openLootbox: "लूटबॉक्स खोलें",
  lootResult: "रिवॉर्ड रिज़ल्ट",
  cost: "लागत",
};

const ar: Record<TranslationKey, string> = hi;
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
    return stored === "hi" || stored === "en" ? stored : "en";
  } catch {
    return "en";
  }
}

function nextLanguage(current: AppLanguage): AppLanguage {
  return current === "hi" ? "en" : "hi";
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<AppLanguage>(readStoredLanguage);

  useEffect(() => {
    try {
      localStorage.setItem("koinara.language", language);
    } catch {
      // no-op
    }
    document.documentElement.lang = language === "hi" ? "hi" : "en";
    document.documentElement.dir = "ltr";
  }, [language]);

  const value = useMemo<LanguageContextShape>(() => {
    return {
      language,
      setLanguage: (next) => setLanguage(next === "hi" ? "hi" : "en"),
      toggleLanguage: () => setLanguage((prev) => nextLanguage(prev)),
      isArabic: false,
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
