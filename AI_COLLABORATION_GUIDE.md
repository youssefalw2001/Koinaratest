# AI Collaboration & Safety Guide

When working with multiple AI agents (Manus, Cursor, Claude, etc.) on the same codebase, things can occasionally "break" due to conflicting changes. Follow this guide to maintain a stable project.

## 1. How to Fix "Messed Up" Code
If an AI agent writes code that breaks your app, use these Git commands to recover:

### **A. Undo the Last Push (Emergency)**
If you just pushed code and the live site broke:
```bash
git reset --hard HEAD~1
git push origin main --force
```
*This rolls the repository back to exactly how it was before the last update.*

### **B. Discard Local Changes**
If the AI is currently editing and the code is a mess, but you haven't committed yet:
```bash
git checkout .
```
*This wipes all uncommitted changes and restores the last clean state.*

### **C. View What Changed**
Before pushing, always ask the AI to show you the "diff":
```bash
git diff
```

---

## 2. Rules for Multi-AI Collaboration
To prevent AIs from fighting each other:

1. **One Task at a Time**: Never have two AIs working on the same file simultaneously.
2. **Pull Before Work**: Always tell the AI to `git pull` before starting a new task to ensure it sees the latest updates from other agents.
3. **Descriptive Commits**: Ensure every AI uses clear commit messages (e.g., `feat: added lootbox animation` instead of `update`). This helps you track who did what.
4. **Use Branches**: For big features, ask the AI to work on a separate branch:
   ```bash
   git checkout -b feature/new-game
   ```
   Only merge it to `main` once you've tested it.

---

## 3. Project-Specific Warnings (Koinara)
*   **Economy Sync**: Always ensure changes to prices in the frontend (`Shop.tsx`) are matched in the backend (`api-server/src/routes/gems.ts`).
*   **Database Schema**: If an AI changes the database (Drizzle), you **must** run a migration/push, or the API will crash.
*   **Environment Variables**: If an AI adds a new feature (like a new TON wallet), ensure you update your Railway/Vercel environment variables.
