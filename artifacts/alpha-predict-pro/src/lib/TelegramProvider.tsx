import { createContext, useContext, useEffect, useState, useRef, ReactNode, useCallback } from "react";
import { useRegisterUser, useGetUser, getGetUserQueryKey } from "@workspace/api-client-react";
import type { User } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { isVipActive } from "@/lib/vipActive";

interface TelegramContextType {
  user: User | null;
  isLoading: boolean;
  refreshUser: () => void;
  showVipPromo: boolean;
  dismissVipPromo: () => void;
}

const TelegramContext = createContext<TelegramContextType>({
  user: null,
  isLoading: true,
  refreshUser: () => {},
  showVipPromo: false,
  dismissVipPromo: () => {},
});

export function TelegramProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [telegramId, setTelegramId] = useState<string | null>(null);
  const [showVipPromo, setShowVipPromo] = useState(false);
  const promoShownRef = useRef(false);
  const queryClient = useQueryClient();
  const registerUser = useRegisterUser();

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
    if (!user || promoShownRef.current || isVipActive(user)) return;

    const gc = user.goldCoins ?? 0;
    const tc = user.tradeCredits ?? 0;
    const wasReferred = !!user.referredBy;

    const shouldShow =
      (tc === 0 && gc > 0) ||
      gc >= 5000 ||
      (wasReferred && !isVipActive(user));

    if (!shouldShow) return;

    const timer = setTimeout(() => {
      promoShownRef.current = true;
      setShowVipPromo(true);
    }, 2000);
    return () => clearTimeout(timer);
  }, [user]);

  const dismissVipPromo = useCallback(() => {
    setShowVipPromo(false);
  }, []);

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
    <TelegramContext.Provider value={{ user, isLoading, refreshUser, showVipPromo, dismissVipPromo }}>
      {children}
    </TelegramContext.Provider>
  );
}

export const useTelegram = () => useContext(TelegramContext);
