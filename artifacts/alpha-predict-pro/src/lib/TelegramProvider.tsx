import { createContext, useContext, useEffect, useState, useRef, ReactNode, useCallback } from "react";
import { useRegisterUser, useGetUser, useActivateVipTrial, getGetUserQueryKey } from "@workspace/api-client-react";
import type { User } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { isVipActive } from "@/lib/vipActive";

interface TelegramContextType {
  user: User | null;
  isLoading: boolean;
  refreshUser: () => void;
  showVipPromo: boolean;
  dismissVipPromo: () => void;
  showDailyLoginPrompt: boolean;
  dismissDailyLoginPrompt: () => void;
  showDay7Celebration: boolean;
  dismissDay7Celebration: () => void;
}

const TelegramContext = createContext<TelegramContextType>({
  user: null,
  isLoading: true,
  refreshUser: () => {},
  showVipPromo: false,
  dismissVipPromo: () => {},
  showDailyLoginPrompt: false,
  dismissDailyLoginPrompt: () => {},
  showDay7Celebration: false,
  dismissDay7Celebration: () => {},
});

function allowLocalDemoUser(): boolean {
  const host = window.location.hostname;
  return import.meta.env.DEV || host === "localhost" || host === "127.0.0.1";
}

function getStableDemoId(): string {
  const key = "koinara_local_demo_telegram_id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const next = `demo_${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(key, next);
  return next;
}

export function TelegramProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [telegramId, setTelegramId] = useState<string | null>(null);
  const [showVipPromo, setShowVipPromo] = useState(false);
  const [showDailyLoginPrompt, setShowDailyLoginPrompt] = useState(false);
  const [showDay7Celebration, setShowDay7Celebration] = useState(false);
  const trialTriggeredRef = useRef(false);
  const dailyPromptShownRef = useRef(false);
  const queryClient = useQueryClient();
  const registerUser = useRegisterUser();
  const activateVipTrialMutation = useActivateVipTrial();

  const { data: freshUser } = useGetUser(telegramId ?? "", {
    query: {
      enabled: !!telegramId,
      queryKey: getGetUserQueryKey(telegramId ?? ""),
      refetchInterval: 5000,
    }
  });

  useEffect(() => {
    if (freshUser) setUser(freshUser);
  }, [freshUser]);

  useEffect(() => {
    if (!user || isVipActive(user)) return;

    const gc = user.goldCoins ?? 0;
    const tc = user.tradeCredits ?? 0;

    let reason: "tc_zero" | "gc_milestone" | "referral" | null = null;
    if (tc === 0) reason = "tc_zero";
    else if (gc >= 5000) reason = "gc_milestone";
    else if (user.referralVipRewardPending) reason = "referral";

    if (!reason || trialTriggeredRef.current) return;

    const timer = setTimeout(async () => {
      trialTriggeredRef.current = true;
      try {
        const updated = await activateVipTrialMutation.mutateAsync({ telegramId: user.telegramId, data: { reason } });
        setUser(updated);
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      } catch {
        setShowVipPromo(true);
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [user]);

  useEffect(() => {
    if (!user || dailyPromptShownRef.current) return;
    const today = new Date().toISOString().split("T")[0];
    if (user.lastLoginDate === today) return;
    dailyPromptShownRef.current = true;
    const timer = setTimeout(() => setShowDailyLoginPrompt(true), 1500);
    return () => clearTimeout(timer);
  }, [user]);

  const dismissVipPromo = useCallback(() => setShowVipPromo(false), []);
  const dismissDailyLoginPrompt = useCallback(() => setShowDailyLoginPrompt(false), []);
  const dismissDay7Celebration = useCallback(() => setShowDay7Celebration(false), []);

  const refreshUser = useCallback(() => {
    if (telegramId) queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(telegramId) });
  }, [telegramId, queryClient]);

  useEffect(() => {
    const initTelegram = async () => {
      try {
        const tg = window.Telegram?.WebApp;
        if (tg) {
          tg.ready();
          tg.expand();
        }

        const tgUser = tg?.initDataUnsafe?.user;
        const referredBy = tg?.initDataUnsafe?.start_param || null;

        if (!tgUser && !allowLocalDemoUser()) {
          console.warn("Telegram user identity missing. Open Koinara from the Telegram bot mini app button.");
          setUser(null);
          return;
        }

        const demoId = tgUser ? null : getStableDemoId();
        const payload = tgUser
          ? {
              telegramId: String(tgUser.id),
              username: tgUser.username,
              firstName: tgUser.first_name,
              lastName: tgUser.last_name,
              photoUrl: tgUser.photo_url,
              referredBy,
            }
          : {
              telegramId: demoId!,
              username: "local_tester",
              firstName: "Local Tester",
              referredBy: null,
            };

        const registeredUser = await registerUser.mutateAsync({ data: payload });
        setUser(registeredUser);
        setTelegramId(registeredUser.telegramId);

        if (registeredUser.day7BonusClaimed) {
          const celebKey = `day7_celebrated_${registeredUser.telegramId}`;
          if (!localStorage.getItem(celebKey)) {
            localStorage.setItem(celebKey, "1");
            setTimeout(() => setShowDay7Celebration(true), 2000);
          }
        }
      } catch (error) {
        console.error("Failed to init telegram user", error);
      } finally {
        setIsLoading(false);
      }
    };

    initTelegram();
  }, []);

  return (
    <TelegramContext.Provider value={{
      user,
      isLoading,
      refreshUser,
      showVipPromo,
      dismissVipPromo,
      showDailyLoginPrompt,
      dismissDailyLoginPrompt,
      showDay7Celebration,
      dismissDay7Celebration,
    }}>
      {children}
    </TelegramContext.Provider>
  );
}

export const useTelegram = () => useContext(TelegramContext);
