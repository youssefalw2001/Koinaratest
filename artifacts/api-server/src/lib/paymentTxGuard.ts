import { eq, or } from "drizzle-orm";
import { db, vipTxHashesTable, minesRoundPassesTable, tcPackTxHashesTable, creatorPassTxHashesTable } from "@workspace/db";

/**
 * Returns true if the given TON transaction hash has already been used
 * for ANY payment type (VIP, mines passes, TC packs, creator pass, or
 * withdrawal verification). Prevents cross-table replay attacks where a
 * single TON payment is redeemed for multiple different products.
 */
export async function isPaymentTxHashUsed(txHash: string): Promise<boolean> {
  const [vip] = await db.select({ id: vipTxHashesTable.id }).from(vipTxHashesTable).where(eq(vipTxHashesTable.txHash, txHash)).limit(1);
  if (vip) return true;

  const [mines] = await db.select({ id: minesRoundPassesTable.id }).from(minesRoundPassesTable).where(eq(minesRoundPassesTable.txHash, txHash)).limit(1);
  if (mines) return true;

  const [tcPack] = await db.select({ id: tcPackTxHashesTable.id }).from(tcPackTxHashesTable).where(eq(tcPackTxHashesTable.txHash, txHash)).limit(1);
  if (tcPack) return true;

  const [creatorPass] = await db.select({ id: creatorPassTxHashesTable.id }).from(creatorPassTxHashesTable).where(eq(creatorPassTxHashesTable.txHash, txHash)).limit(1);
  if (creatorPass) return true;

  return false;
}
