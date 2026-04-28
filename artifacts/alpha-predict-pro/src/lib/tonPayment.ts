import { beginCell } from "@ton/core";

export type TonMessage = { address: string; amount: string; payload?: string };
export type TonTransaction = { validUntil: number; messages: TonMessage[] };

const API_BASE = `${(import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""}/api`;

export function commentPayload(comment: string): string {
  return beginCell().storeUint(0, 32).storeStringTail(comment).endCell().toBoc().toString("base64");
}

export function paymentTx(address: string, amount: string, memo: string): TonTransaction {
  return {
    validUntil: Math.floor(Date.now() / 1000) + 600,
    messages: [{ address, amount, payload: commentPayload(memo) }],
  };
}

export async function fetchTcPackMemo(input: { telegramId: string; packId: string; initData: string }): Promise<string> {
  const url = `${API_BASE}/exchange/tc-pack/memo?telegramId=${encodeURIComponent(input.telegramId)}&packId=${encodeURIComponent(input.packId)}`;
  const res = await fetch(url, { headers: input.initData ? { "x-telegram-init-data": input.initData } : {} });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.memo) throw new Error(data?.error ?? "Could not load TC pack memo.");
  return data.memo as string;
}

export async function fetchMinesPassMemo(input: { telegramId: string; tier: string; packSize: number; initData: string }): Promise<string> {
  const url = `${API_BASE}/mines/passes/memo?telegramId=${encodeURIComponent(input.telegramId)}&tier=${encodeURIComponent(input.tier)}&packSize=${input.packSize}`;
  const res = await fetch(url, { headers: input.initData ? { "x-telegram-init-data": input.initData } : {} });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.memo) throw new Error(data?.error ?? "Could not load Mines pass memo.");
  return data.memo as string;
}

export async function verifyTcPackPurchase(input: { telegramId: string; packId: string; senderAddress: string; initData: string }) {
  const res = await fetch(`${API_BASE}/exchange/tc-pack/purchase`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(input.initData ? { "x-telegram-init-data": input.initData } : {}) },
    body: JSON.stringify({ telegramId: input.telegramId, packId: input.packId, senderAddress: input.senderAddress }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? "TC pack payment verification failed.");
  return data;
}

export function inferKoinaraMemoFromAmount(input: { amount: string; telegramId: string }): string | null {
  const amount = input.amount;
  const id = input.telegramId;
  const tcPack: Record<string, string> = {
    "200000000": `KNR-PACK-micro-${id}`,
    "600000000": `KNR-PACK-starter-${id}`,
    "2000000000": `KNR-PACK-pro-${id}`,
    "10000000000": `KNR-PACK-whale-${id}`,
  };
  const minesPass: Record<string, string> = {
    "50000000": `KNR-MINES-bronze-1-${id}`,
    "195000000": `KNR-MINES-bronze-5-${id}`,
    "345000000": `KNR-MINES-bronze-10-${id}`,
    "100000000": `KNR-MINES-silver-1-${id}`,
    "390000000": `KNR-MINES-silver-5-${id}`,
    "690000000": `KNR-MINES-silver-10-${id}`,
    "250000000": `KNR-MINES-gold-1-${id}`,
    "975000000": `KNR-MINES-gold-5-${id}`,
    "1725000000": `KNR-MINES-gold-10-${id}`,
  };
  return tcPack[amount] ?? minesPass[amount] ?? null;
}

export function withRequiredMemo(tx: TonTransaction, telegramId: string): TonTransaction {
  return {
    ...tx,
    messages: tx.messages.map((message) => {
      if (message.payload) return message;
      const memo = inferKoinaraMemoFromAmount({ amount: message.amount, telegramId });
      return memo ? { ...message, payload: commentPayload(memo) } : message;
    }),
  };
}
