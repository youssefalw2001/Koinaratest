import { Gift, Rocket, Tv, Users, ArrowRight } from "lucide-react";
import { Link } from "wouter";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";

export default function EarnCreatorSimple() {
  const { user } = useTelegram();
  const vip = isVipActive(user);
  const adReward = vip ? 100 : 80;

  return <div className="min-h-screen bg-black px-4 pb-28 pt-4 text-white">
    <style>{`.earn-card{background:linear-gradient(160deg,rgba(15,24,42,.82),rgba(5,8,16,.95));border:1px solid rgba(255,215,0,.18);box-shadow:0 18px 55px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.05);backdrop-filter:blur(18px)}`}</style>
    <div className="mb-4 flex items-center gap-2"><Gift size={16} className="text-[#FFD700]"/><span className="font-mono text-xs tracking-[0.18em] text-white/60 uppercase">Earn</span></div>

    <section className="earn-card relative mb-4 overflow-hidden rounded-3xl p-5">
      <div className="absolute -right-10 -top-12 h-36 w-36 rounded-full bg-[#FFD700]/14 blur-3xl"/>
      <div className="relative z-10">
        <div className="mb-2 flex items-center gap-2 font-mono text-[10px] font-black uppercase tracking-[0.2em] text-[#FFD700]"><Rocket size={13}/>Creator Lane</div>
        <h1 className="text-3xl font-black leading-tight">Build your Koinara network.</h1>
        <p className="mt-2 font-mono text-[11px] leading-relaxed text-white/45">Creator stats now live in one simple place: balance, rank, invite link, and progress.</p>
        <Link href="/creator"><button className="mt-4 w-full rounded-2xl bg-[#FFD700] py-4 font-black text-black">Open Creator Center <ArrowRight size={16} className="ml-1 inline" /></button></Link>
      </div>
    </section>

    <section className="earn-card mb-4 rounded-3xl p-4 border-[#FF4D8D]/30">
      <div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-3"><Tv size={22} className="text-[#FF4D8D]"/><div><div className="font-black text-lg">Watch Ad</div><div className="font-mono text-[10px] text-white/45">Quick TC task</div></div></div><div className="font-mono text-lg font-black text-[#FF4D8D]">+{adReward} TC</div></div>
      <div className="rounded-2xl border border-[#FF4D8D]/25 bg-[#FF4D8D]/10 py-3 text-center font-mono text-sm font-black text-[#FF4D8D]">Use daily tasks to collect extra Trade Credits</div>
    </section>

    <section className="earn-card mb-4 rounded-3xl p-4">
      <div className="mb-3 font-black text-lg">Simple earning paths</div>
      <div className="space-y-2">
        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-3"><div className="font-black">1. Complete simple tasks</div><div className="font-mono text-[10px] text-white/35">Use Earn for quick app tasks.</div></div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-3"><div className="font-black">2. Grow in Creator Center</div><div className="font-mono text-[10px] text-white/35">Creator numbers stay separate and easy to understand.</div></div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-3"><div className="font-black">3. Unlock VIP Creator</div><div className="font-mono text-[10px] text-white/35">Upgrade for better creator status and perks.</div></div>
      </div>
    </section>

    <Link href="/creator"><section className="rounded-3xl border border-[#00F5FF]/25 bg-[#00F5FF]/10 p-4"><div className="flex items-center justify-between"><div className="flex items-center gap-3"><Users size={22} className="text-[#00F5FF]"/><div><div className="font-black text-lg">Creator Center</div><div className="font-mono text-[10px] text-white/42">Your creator dashboard.</div></div></div><ArrowRight size={18} className="text-[#00F5FF]"/></div></section></Link>
  </div>;
}
