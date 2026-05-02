import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { buildStarsPayload, findStarsProduct, type StarsProductType } from "../lib/starsCatalog";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";

const router: IRouter = Router();

const Body = z.object({
  telegramId: z.string().min(1),
  productType: z.enum(["tc_pack", "gem", "mines_pass"]),
  productId: z.string().min(1).max(80),
});

function getBotToken(): string | null {
  const primary = process.env.TELEGRAM_BOT_TOKEN?.split(",")[0]?.trim();
  if (primary) return primary;
  const extraKey = ["TELEGRAM", "BOT", "TOKENS"].join("_");
  return ((process.env as Record<string, string | undefined>)[extraKey] ?? "").split(",")[0]?.trim() || null;
}

router.post("/stars/create-invoice", async (req, res): Promise<void> => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid Stars invoice request." });
    return;
  }

  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;

  const product = findStarsProduct(parsed.data.productType, parsed.data.productId);
  if (!product) {
    res.status(400).json({ error: "Unsupported Stars product." });
    return;
  }

  const botToken = getBotToken();
  if (!botToken) {
    res.status(503).json({ error: "Telegram Stars payments are not configured." });
    return;
  }

  const payload = buildStarsPayload(product.productType as StarsProductType, telegramId, product.productId);
  const response = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: product.title,
      description: product.description,
      payload,
      currency: "XTR",
      prices: [{ label: product.title, amount: product.starsAmount }],
      provider_token: "",
    }),
  });

  const data = await response.json().catch(() => null) as { ok?: boolean; result?: string; description?: string } | null;
  if (!response.ok || !data?.ok || !data.result) {
    res.status(502).json({ error: data?.description ?? "Could not create Telegram Stars invoice." });
    return;
  }

  res.json({ invoiceLink: data.result, starsAmount: product.starsAmount, payload });
});

export default router;
