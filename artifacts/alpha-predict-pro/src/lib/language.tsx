import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type AppLanguage = "en" | "ar";

type TranslationKey =
  | "appName"
  | "trade"
  | "crash"
  | "earn"
  | "shop"
  | "wallet"
  | "profile"
  | "vip"
  | "language"
  | "english"
  | "arabic"
  | "tradeArena"
  | "earnCenter"
  | "gemShop"
  | "walletTitle"
  | "profileTitle";

const translations: Record<AppLanguage, Record<TranslationKey, string>> = {
  en: {
    appName: "KOINARA",
    trade: "Trade",
    crash: "Crash",
    earn: "Earn",
    shop: "Shop",
    wallet: "Wallet",
    profile: "Profile",
    vip: "VIP",
    language: "Language",
    english: "English",
    arabic: "Arabic",
    tradeArena: "Trade Arena",
    earnCenter: "Earn Center",
    gemShop: "Gem Shop",
    walletTitle: "Koinara Wallet",
    profileTitle: "Profile",
  },
  ar: {
    appName: "كوينارا",
    trade: "تداول",
    crash: "كراش",
    earn: "اكسب",
    shop: "المتجر",
    wallet: "المحفظة",
    profile: "الملف",
    vip: "النخبة",
    language: "اللغة",
    english: "الإنجليزية",
    arabic: "العربية",
    tradeArena: "ساحة التداول",
    earnCenter: "مركز المكافآت",
    gemShop: "متجر التعزيزات",
    walletTitle: "محفظة كوينارا",
    profileTitle: "الملف الشخصي",
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
