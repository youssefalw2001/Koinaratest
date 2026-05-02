export type StarsProductType = "tc_pack" | "gem" | "mines_pass";

export type StarsProduct = {
  productType: StarsProductType;
  productId: string;
  title: string;
  description: string;
  starsAmount: number;
  tcAmount?: number;
  gemType?: string;
  gemUses?: number;
  expiresHours?: number | null;
  minesTier?: "bronze" | "silver" | "gold";
  minesPasses?: number;
};

const products: StarsProduct[] = [
  { productType: "tc_pack", productId: "micro", title: "Micro Refill", description: "7,000 TC for Koinara Battles", starsAmount: 80, tcAmount: 7_000 },
  { productType: "tc_pack", productId: "starter", title: "Starter Pack", description: "30,000 TC for Koinara Battles", starsAmount: 230, tcAmount: 30_000 },
  { productType: "tc_pack", productId: "pro", title: "Pro Pack", description: "150,000 TC for Koinara Battles", starsAmount: 570, tcAmount: 150_000 },
  { productType: "tc_pack", productId: "whale", title: "Whale Pack", description: "1,000,000 TC for Koinara Battles", starsAmount: 3750, tcAmount: 1_000_000 },

  { productType: "gem", productId: "shield", title: "Shield", description: "Battle Shield power-up", starsAmount: 50, gemType: "battle_shield", gemUses: 1, expiresHours: null },
  { productType: "gem", productId: "battle_pass_weekly", title: "Battle Pass", description: "7 days of Battle status and priority queue", starsAmount: 225, gemType: "battle_pass", gemUses: 1, expiresHours: 24 * 7 },
  { productType: "gem", productId: "streak_saver", title: "Streak Saver", description: "Protect Battle streak display once", starsAmount: 75, gemType: "battle_streak_saver", gemUses: 1, expiresHours: null },
  { productType: "gem", productId: "priority_queue", title: "Priority Queue", description: "24h Battle matchmaking priority", starsAmount: 60, gemType: "battle_priority_queue", gemUses: 1, expiresHours: 24 },

  { productType: "gem", productId: "safe_reveal", title: "Safe Reveal", description: "Mines power-up", starsAmount: 10, gemType: "safe_reveal", gemUses: 1, expiresHours: null },
  { productType: "gem", productId: "gem_magnet", title: "Gem Magnet", description: "Mines power-up", starsAmount: 15, gemType: "gem_magnet", gemUses: 3, expiresHours: null },
  { productType: "gem", productId: "revenge_shield", title: "Revenge Shield", description: "Mines power-up", starsAmount: 20, gemType: "revenge_shield", gemUses: 1, expiresHours: null },
  { productType: "gem", productId: "second_chance", title: "Second Chance", description: "Mines power-up", starsAmount: 25, gemType: "second_chance", gemUses: 1, expiresHours: null },

  { productType: "mines_pass", productId: "bronze_1x", title: "Bronze Mines Pass", description: "1 Bronze Mines round", starsAmount: 5, minesTier: "bronze", minesPasses: 1 },
  { productType: "mines_pass", productId: "bronze_5x", title: "Bronze Mines Pass 5x", description: "5 Bronze Mines rounds", starsAmount: 20, minesTier: "bronze", minesPasses: 5 },
  { productType: "mines_pass", productId: "bronze_10x", title: "Bronze Mines Pass 10x", description: "10 Bronze Mines rounds", starsAmount: 35, minesTier: "bronze", minesPasses: 10 },
  { productType: "mines_pass", productId: "silver_1x", title: "Silver Mines Pass", description: "1 Silver Mines round", starsAmount: 10, minesTier: "silver", minesPasses: 1 },
  { productType: "mines_pass", productId: "silver_5x", title: "Silver Mines Pass 5x", description: "5 Silver Mines rounds", starsAmount: 39, minesTier: "silver", minesPasses: 5 },
  { productType: "mines_pass", productId: "silver_10x", title: "Silver Mines Pass 10x", description: "10 Silver Mines rounds", starsAmount: 69, minesTier: "silver", minesPasses: 10 },
  { productType: "mines_pass", productId: "gold_1x", title: "Gold Mines Pass", description: "1 Gold Mines round", starsAmount: 25, minesTier: "gold", minesPasses: 1 },
  { productType: "mines_pass", productId: "gold_5x", title: "Gold Mines Pass 5x", description: "5 Gold Mines rounds", starsAmount: 98, minesTier: "gold", minesPasses: 5 },
  { productType: "mines_pass", productId: "gold_10x", title: "Gold Mines Pass 10x", description: "10 Gold Mines rounds", starsAmount: 173, minesTier: "gold", minesPasses: 10 },
];

export function findStarsProduct(productType: string, productId: string): StarsProduct | null {
  return products.find((product) => product.productType === productType && product.productId === productId) ?? null;
}

export function allStarsProducts(): StarsProduct[] {
  return products;
}

export function buildStarsPayload(productType: StarsProductType, telegramId: string, productId: string): string {
  return `${productType}:${telegramId}:${productId}`;
}

export function parseStarsPayload(payload: string): { productType: StarsProductType; telegramId: string; productId: string } | null {
  const [productType, telegramId, productId] = payload.split(":");
  if (!productType || !telegramId || !productId) return null;
  if (productType !== "tc_pack" && productType !== "gem" && productType !== "mines_pass") return null;
  return { productType, telegramId, productId };
}
