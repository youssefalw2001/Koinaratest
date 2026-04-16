import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { useRegisterUser, useGetUser, getGetUserQueryKey } from "@workspace/api-client-react";
import type { User } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

interface TelegramContextType {
  user: User | null;
  isLoading: boolean;
  refreshUser: () => void;
}

const TelegramContext = createContext<TelegramContextType>({
  user: null,
  isLoading: true,
  refreshUser: () => {},
});

export function TelegramProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [telegramId, setTelegramId] = useState<string | null>(null);
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
    <TelegramContext.Provider value={{ user, isLoading, refreshUser }}>
      {children}
    </TelegramContext.Provider>
  );
}

export const useTelegram = () => useContext(TelegramContext);
