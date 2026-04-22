import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Coins,
  Gem,
  Zap,
  Package,
  Crown,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
} from "lucide-react";
import { useTonConnectUI, useTonAddress } from "@tonconnect/ui-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useLanguage } from "@/lib/language";
import { useQueryClient } from "@tanstack/react-query";
import { getGetUserQueryKey } from "@workspace/api-client-react";

type TcPack = {
  id: "small" | "medium" | "large" | "jumbo";
  label: string;
  priceTon: string;
  priceTonNano: string;
  tcAwarded: number;
  bonusPct: number;
};

type PacksResponse = {
  packs: TcPack[];
};

type TcPackPurchaseResponse = {
  pack: TcPack["id"];
  tcAwarded: number;
  txHash: string;
  balances: { goldCoins: number; tradeCredits: number };
};

function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
  return `${base}${path}`;
}

const PACK_ICON: Record<TcPack["id"], React.ComponentType<{ size?: number; className?: string }>> = {
  small: Zap,
  medium: Coins,
  large: Gem,
  jumbo: Crown,
};
const PACK_COLOR: Record<TcPack["id"], string> = {
  small: "#4DA3FF",
  medium: "#00E676",
  large: "#9D5CFF",
  jumbo: "#FFD700",
};

export default function Exchange() {
  const { user, refreshUser } = useTelegram();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [packs, setPacks] = useState<PacksResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  // TON packs state
  const [pendingPack, setPendingPack] = useState<TcPack["id"] | null>(null);
  const [tonConnectUI] = useTonConnectUI();
  const tonAddress = useTonAddress();

  useEffect(() => {
    let aborted = false;
    void (async () => {
      try {
        const res = await fetch(apiUrl("/api/exchange/tc-packs"));
        if (!res.ok) throw new Error("Failed to load packs");
        const data = (await res.json()) as PacksResponse;
        if (!aborted) setPacks(data);
      } catch (err) {
        if (!aborted) setLoadError(err instanceof Error ? err.message : "Could not load packs");
      }
    })();
    return () => {
      aborted = true;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const handleBuyPack = async (pack: TcPack) => {
    if (!user || busy) return;
    if (!tonAddress) {
      setToast({ kind: "err", msg: "Connect your TON wallet first." });
      return;
    }
    const operatorWallet = (import.meta.env.VITE_KOINARA_TON_WALLET as string | undefined)?.trim();
    if (!operatorWallet) {
      setToast({ kind: "err", msg: "Pack purchases are not configured yet." });
      return;
    }

    setBusy(true);
    setPendingPack(pack.id);
    setToast(null);

    try {
      // 1) Send TON payment
      await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 300,
        messages: [
          {
            address: operatorWallet,
            amount: pack.priceTonNano,
          },
        ],
      });

      // 2) Poll the verifier
      let lastError = "Payment verification timed out.";
      for (let attempt = 0; attempt < 6; attempt++) {
        await new Promise((r) => setTimeout(r, 8_000));
        const res = await fetch(apiUrl("/api/exchange/tc-pack/purchase"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(window.Telegram?.WebApp?.initData
              ? { "X-Telegram-Init-Data": window.Telegram.WebApp.initData }
              : {}),
          },
          body: JSON.stringify({
            telegramId: user.telegramId,
            packId: pack.id,
            senderAddress: tonAddress,
          }),
        });
        const data = (await res.json()) as TcPackPurchaseResponse | { error?: string };
        if (res.ok) {
          const ok = data as TcPackPurchaseResponse;
          setToast({ kind: "ok", msg: `${pack.label}: +${ok.tcAwarded.toLocaleString()} TC credited` });
          refreshUser();
          queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
          return;
        }
        lastError = (data as { error?: string }).error ?? lastError;
        if (res.status === 409 || res.status === 503) break; // terminal errors
      }
      setToast({ kind: "err", msg: lastError });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "TON payment failed.";
      setToast({ kind: "err", msg });
    } finally {
      setBusy(false);
      setPendingPack(null);
    }
  };

  return (
    <div className="px-4 pt-4 pb-8 flex flex-col gap-4">
      <div className="app-card p-4">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles size={14} className="text-[#4DA3FF]" />
          <span className="font-mono text-xs tracking-[0.16em] uppercase text-white/70">
            {t("tradeCredits")}
          </span>
        </div>
        <div className="font-mono text-[11px] text-white/45 mb-3">
          Purchase Trade Credits (TC) to power your trading and unlock premium features.
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {loadError && !packs && (
          <div className="rounded-xl border border-[#FF1744]/30 bg-[#FF1744]/10 px-3 py-2">
            <span className="font-mono text-xs text-[#ffb3c2]">{loadError}</span>
          </div>
        )}
        {!packs && !loadError && (
          <div className="app-card p-4 font-mono text-xs text-white/45">Loading packs...</div>
        )}
        {packs?.packs.map((pack) => {
          const Icon = PACK_ICON[pack.id];
          const color = PACK_COLOR[pack.id];
          const pending = pendingPack === pack.id;
          return (
            <div
              key={pack.id}
              className="app-card p-4 flex items-center justify-between"
              style={{
                borderColor: `${color}33`,
                background: `linear-gradient(90deg, ${color}0a, transparent 55%)`,
              }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center"
                  style={{ background: `${color}22`, color }}
                >
                  <Icon size={18} />
                </div>
                <div>
                  <div className="font-mono text-sm font-black text-white flex items-center gap-1.5">
                    {pack.label}
                    {pack.bonusPct > 0 && (
                      <span
                        className="text-[9px] px-1.5 py-0.5 rounded font-bold"
                        style={{ background: `${color}20`, color }}
                      >
                        +{pack.bonusPct}% BONUS
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[10px] text-white/55 mt-0.5">
                    {pack.tcAwarded.toLocaleString()} TC · {pack.priceTon} TON
                  </div>
                </div>
              </div>
              <button
                onClick={() => handleBuyPack(pack)}
                disabled={busy}
                className="px-3 py-2 rounded-lg font-mono text-[11px] font-black border disabled:opacity-35"
                style={{ borderColor: `${color}5c`, background: `${color}1a`, color }}
              >
                {pending ? t("confirmingTx").toUpperCase() : t("buy").toUpperCase()}
              </button>
            </div>
          );
        })}
        {!tonAddress && packs && (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 flex items-center gap-2">
            <Package size={12} className="text-white/50" />
            <span className="font-mono text-[10px] text-white/50">
              Connect a TON wallet in the Wallet tab to purchase packs.
            </span>
          </div>
        )}
      </div>

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className={`rounded-xl border px-3 py-2 flex items-center gap-2 ${
              toast.kind === "ok"
                ? "border-[#00E676]/30 bg-[#00E676]/10"
                : "border-[#FF1744]/30 bg-[#FF1744]/10"
            }`}
          >
            {toast.kind === "ok" ? (
              <CheckCircle2 size={14} className="text-[#00E676]" />
            ) : (
              <AlertTriangle size={14} className="text-[#ffb3c2]" />
            )}
            <span
              className={`font-mono text-xs ${
                toast.kind === "ok" ? "text-[#b7ffd4]" : "text-[#ffb3c2]"
              }`}
            >
              {toast.msg}
            </span>
            {toast.kind === "ok" && (
              <Sparkles size={12} className="ml-auto text-[#FFD700]" />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
