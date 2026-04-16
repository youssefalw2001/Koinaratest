import { Link, useLocation } from "wouter";
import { Zap, Gift, Wallet, Trophy, User } from "lucide-react";

const tabs = [
  { path: "/", icon: Zap, label: "Terminal" },
  { path: "/earn", icon: Gift, label: "Earn" },
  { path: "/wallet", icon: Wallet, label: "Wallet" },
  { path: "/leaderboard", icon: Trophy, label: "Ranks" },
  { path: "/profile", icon: User, label: "Profile" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="flex flex-col min-h-screen max-w-[420px] mx-auto bg-black text-white">
      <main className="flex-1 overflow-y-auto pb-20">
        {children}
      </main>
      <nav className="fixed bottom-0 left-0 right-0 max-w-[420px] mx-auto z-50 border-t border-white/10 bg-black/95 backdrop-blur-xl">
        <div className="flex">
          {tabs.map(({ path, icon: Icon, label }) => {
            const active = location === path || (path !== "/" && location.startsWith(path));
            return (
              <Link key={path} href={path} className="flex-1">
                <div className={`flex flex-col items-center py-3 gap-1 transition-all duration-200 ${active ? "text-[#00f0ff]" : "text-white/40"}`}>
                  <Icon
                    size={20}
                    className={active ? "drop-shadow-[0_0_8px_#00f0ff]" : ""}
                  />
                  <span className="text-[9px] font-mono font-bold tracking-widest uppercase">{label}</span>
                </div>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
