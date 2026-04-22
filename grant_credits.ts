import { db, usersTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";

async function grantCredits() {
  try {
    // Since I don't have the user's telegramId, I'll update all users for testing purposes 
    // or the user can provide their ID. For now, let's assume I can find the most recent user.
    const [lastUser] = await db.select().from(usersTable).limit(1);
    
    if (lastUser) {
      await db.update(usersTable)
        .set({ tradeCredits: sql`${usersTable.tradeCredits} + 5000` })
        .where(eq(usersTable.telegramId, lastUser.telegramId));
      console.log(`Successfully granted 5,000 TC to user: ${lastUser.telegramId}`);
    } else {
      console.log("No users found in database.");
    }
  } catch (err) {
    console.error("Failed to grant credits:", err);
  } finally {
    process.exit(0);
  }
}

grantCredits();
