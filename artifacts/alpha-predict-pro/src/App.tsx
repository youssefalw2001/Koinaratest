import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TonConnectUIProvider } from "@tonconnect/ui-react";
import NotFound from "@/pages/not-found";
import { TelegramProvider } from "./lib/TelegramProvider";
import { Layout } from "./components/Layout";

// Pages
import Terminal from "./pages/Terminal";
import Earn from "./pages/Earn";
import Wallet from "./pages/Wallet";
import Leaderboard from "./pages/Leaderboard";
import Profile from "./pages/Profile";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Terminal} />
        <Route path="/earn" component={Earn} />
        <Route path="/wallet" component={Wallet} />
        <Route path="/leaderboard" component={Leaderboard} />
        <Route path="/profile" component={Profile} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  return (
    <TonConnectUIProvider manifestUrl={`${window.location.origin}${import.meta.env.BASE_URL}tonconnect-manifest.json`}>
      <QueryClientProvider client={queryClient}>
        <TelegramProvider>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <Router />
            </WouterRouter>
            <Toaster />
          </TooltipProvider>
        </TelegramProvider>
      </QueryClientProvider>
    </TonConnectUIProvider>
  );
}

export default App;
