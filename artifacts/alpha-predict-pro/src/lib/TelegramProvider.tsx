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
}

const TelegramContext = createContext<TelegramContextType>({
  user: null,
  isLoading: true,
  refreshUser: () => {},
  showVipPromo: false,
  dismissVipPromo: () => {},
  showDailyLoginPrompt: false,
  dismissDailyLoginPrompt: () => {},
});

export function TelegramProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [telegramId, setTelegramId] = useState<string | null>(null);
  const [showVipPromo, setShowVipPromo] = useState(false);
  const [showDailyLoginPrompt, setShowDailyLoginPrompt] = useState(false);
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
    if (freshUser) {
      setUser(freshUser);
    }
  }, [freshUser]);

  useEffect(() => {
    if (!user || isVipActive(user)) return;

    const gc = user.goldCoins ?? 0;
    const tc = user.tradeCredits ?? 0;
    const wasReferred = !!user.referredBy;

    let reason: "tc_zero" | "gc_milestone" | "referral" | null = null;
    if (tc === 0 && gc > 0) reason = "tc_zero";
    else if (gc >= 5000) reason = "gc_milestone";
    else if (wasReferred) reason = "referral";

    if (!reason || trialTriggeredRef.current) return;

    const timer = setTimeout(async () => {
      trialTriggeredRef.current = true;
      try {
        const updated = await activateVipTrialMutation.mutateAsync({
          telegramId: user.telegramId,
          data: { reason },
        });
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

  const refreshUser = useCallback(() => {
    if (telegramId) {
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(telegramId) });
    }
  }, [telegramId, queryClient]);

  useEffect(() => {
    const initTelegram = async () => {
      try {
        const tg = (window as any).Telegram?.WebApp;
        if (tg) {
          tg.ready();
          tg.expand();
        }

        const tgUser = tg?.initDataUnsafe?.user;
        const referredBy = tg?.initDataUnsafe?.start_param || null;

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
              telegramId: "demo_user_123",
              username: "koin_trader",
              firstName: "Koin",
              referredBy: null,
            };

        const registeredUser = await registerUser.mutateAsync({ data: payload });
        setUser(registeredUser);
        setTelegramId(registeredUser.telegramId);
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
    }}>
      {children}
    </TelegramContext.Provider>
  );
}

export const useTelegram = () => useContext(TelegramContext);
