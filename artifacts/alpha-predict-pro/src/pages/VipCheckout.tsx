import { useEffect, useState } from "react";
import { Link } from "wouter";
import { CheckCircle, Crown, Loader2, Shield, Wallet, Zap } from "lucide-react";
import { useTonAddress, useTonConnectUI } from "@tonconnect/ui-react";
import { getGetUserQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";
import { commentPayload } from "@/lib/tonPayment";

const PRODUCTION_API_URL = "https://workspaceapi-server-production-4e16.up.railway.app";
const API_ROOT = ((import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || PRODUCTION_API_URL);
const API_BASE = `${API_ROOT}/api`;
const VIP_MONTHLY_NANO = "1700000000";
const OPERATOR_TON_WALLET = (import.meta.env.VITE_KOINARA_TON_WALLET || import.meta.env.VITE_TON_WALLET) as string | undefined;

function initHeaders(): Record<string, string> {
  const initData = window.Telegram?.WebApp?.initData ?? "";
  return initData ? { "x-telegram-init-data": initData } : {};
}

function shortAddress(address?: string | null): string {
  return address ? `${address.slice(0, 6)}...${address.slice(-6)}` : "Not connected";
}

export default function VipCheckout() {
  const { user, refreshUser } = useTelegram();
  const queryClient = useQueryClient();
  const [tonConnectUI] = useTonConnectUI();
  const tonAddress = useTonAddress();
  const vip = isVipActive(user);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    try { localStorage.removeItem("koinara_auto_vip_checkout"); } catch {}
  }, []);

  const activateVip = async () => {
    if (!user?.telegramId || busy) return;
    if (!OPERATOR_TON_WALLET) { setMessage("VIP payments are not configured yet."); return; }

    setBusy(true);
    setMessage(null);
    try {
      if (!tonConnectUI.connected) {
        await tonConnectUI.openModal();
        setMessage("Connect Tonkeeper, then tap Activate VIP again.");
        return;
      }

      const senderAddress = tonConnectUI.account?.address || tonAddress || user.walletAddress;
      if (!senderAddress) {
        setMessage("Connect your TON wallet first, then tap Activate VIP again.");
        return;
      }

      if (user.walletAddress !== senderAddress) {
        await fetch(`${API_BASE}/users/${encodeURIComponent(user.telegramId)}/wallet`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...initHeaders() },
          body: JSON.stringify({ walletAddress: senderAddress }),
        });
      }

      const memoRes = await fetch(`${API_BASE}/users/${encodeURIComponent(user.telegramId)}/vip/memo`, { headers: initHeaders() });
      const memoData = await memoRes.json().catch(() => ({}));
      if (!memoRes.ok || !memoData?.memo) throw new Error(memoData?.error ?? "Could not load VIP payment memo.");

      await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 600,
        messages: [{ address: OPERATOR_TON_WALLET, amount: VIP_MONTHLY_NANO, payload: commentPayload(String(memoData.memo)) }],
      });

      setMessage("Payment sent. Verifying on-chain confirmation...");
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const subRes = await fetch(`${API_BASE}/users/${encodeURIComponent(user.telegramId)}/vip/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...initHeaders() },
        body: JSON.stringify({ plan: "monthly", senderAddress }),
      });
      const subData = await subRes.json().catch(() => ({}));
      if (!subRes.ok) throw new Error(subData?.error ?? "VIP activation failed. Please retry after transaction confirms.");

      setMessage("VIP activated. Creator Pass included.");
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      await refreshUser();
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success");
    } catch (error) {
      const msg = error instanceof Error ? error.message : "VIP activation failed.";
      setMessage(msg.includes("rejected") || msg.includes("Cancelled") ? "Transaction cancelled." : msg);
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("error");
    } finally {
      setBusy(false);
    }
  };

  return <div className="min-h-screen bg-[#05070d] px-3 pb-28 pt-3 text-white">
    <style>{`.vip-card{background:linear-gradient(160deg,rgba(36,18,58,.86),rgba(6,8,16,.96));border:1px solid rgba(255,215,0,.22);box-shadow:0 18px 60px rgba(0,0,0,.44),0 0 42px rgba(255,215,0,.1),inset 0 1px 0 rgba(255,255,255,.07);backdrop-filter:blur(18px)}`}</style>

    <section className="vip-card mb-3 rounded-[30px] p-5 text-center">
      <div className="mx-auto mb-3 flex h-20 w-20 items-center justify-center rounded-full border border-[#FFD700]/45 bg-[#FFD700]/12 shadow-[0_0_35px_rgba(255,215,0,.25)]"><Crown size={42} className="text-[#FFD700]" /></div>
      <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#FFD700]">Koinara VIP</div>
      <h1 className="mt-1 text-3xl font-black">Activate VIP</h1>
      <p className="mt-2 font-mono text-[11px] leading-relaxed text-white/48">VIP is paid-only. No free trials. Get bigger Battle limits, higher caps, lower withdrawal requirements, and Creator Pass included.</p>
      {vip && <div className="mt-4 rounded-2xl border border-[#00F5A0]/25 bg-[#00F5A0]/10 p-3 font-mono text-xs font-black text-[#00F5A0]"><CheckCircle size={14} className="mr-1 inline"/>VIP is active on this account.</div>}
    </section>

    <section className="vip-card mb-3 rounded-[30px] p-4">
      <div className="mb-3 flex items-center gap-2"><Zap size={17} className="text-[#FFD700]"/><h2 className="font-black">VIP Benefits</h2></div>
      <div className="space-y-2">
        {["Battle max stake: 5,000 TC", "Battle GC daily cap: 15,000", "Mines daily cap: 20,000 GC", "Lower GC withdrawal minimum", "Creator Pass included automatically"].map((item) => <div key={item} className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.025] p-3 font-mono text-[11px] text-white/70"><CheckCircle size={13} className="shrink-0 text-[#FFD700]"/>{item}</div>)}
      </div>
    </section>

    <section className="vip-card mb-3 rounded-[30px] p-4">
      <div className="mb-2 flex items-center gap-2"><Wallet size={17} className="text-[#8BC3FF]"/><h2 className="font-black">Payment</h2></div>
      <div className="rounded-2xl border border-[#8BC3FF]/20 bg-[#8BC3FF]/8 p-3">
        <div className="font-mono text-[9px] text-white/38">Connected wallet</div>
        <div className="mt-1 break-all font-mono text-sm font-black text-[#8BC3FF]">{shortAddress(tonAddress || user?.walletAddress)}</div>
      </div>
      <div className="mt-3 rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/8 p-3 font-mono text-[10px] leading-relaxed text-[#FFD700]/90">
        Price: 1.7 TON / $5.99 monthly. Tonkeeper will open with the exact Koinara VIP memo.
      </div>
      <button onClick={activateVip} disabled={!user || busy || vip} className="mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#FFD700] to-[#FF9900] font-black text-black disabled:opacity-45">
        {busy ? <><Loader2 size={17} className="animate-spin"/>Processing VIP</> : vip ? "VIP ACTIVE" : "Activate VIP with TON"}
      </button>
      <button onClick={() => tonConnectUI.openModal()} className="mt-2 w-full rounded-2xl border border-[#8BC3FF]/25 bg-[#8BC3FF]/8 py-3 font-mono text-xs font-black text-[#8BC3FF]">{tonAddress ? "Switch TON Wallet" : "Connect TON Wallet"}</button>
      {message && <div className="mt-3 rounded-2xl border border-[#FFD700]/25 bg-black/35 p-3 font-mono text-[10px] leading-relaxed text-[#FFD700]">{message}</div>}
    </section>

    <section className="rounded-3xl border border-[#FF4D6D]/20 bg-[#FF4D6D]/7 p-3 font-mono text-[10px] leading-relaxed text-white/45">
      <Shield size={13} className="mr-1 inline text-[#FF8FA3]"/>VIP does not guarantee winnings and does not bypass server-side withdrawal, cap, or anti-abuse rules.
    </section>

    <Link href="/wallet" className="mt-3 block rounded-2xl border border-white/10 bg-white/[0.035] py-3 text-center font-mono text-xs font-black text-white/50">Go to Wallet instead</Link>
  </div>;
}
