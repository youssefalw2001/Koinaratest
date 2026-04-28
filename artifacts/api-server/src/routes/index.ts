import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import predictionsRouter from "./predictions";
import questsRouter from "./quests";
import rewardsRouter from "./rewards";
import withdrawalsRouter from "./withdrawals";
import gemsRouter from "./gems";
import contentSubmitGuardRouter from "./contentSubmitGuard";
import contentStatusGuardRouter from "./contentStatusGuard";
import contentRouter from "./content";
import crashRouter from "./crash";
import marketRouter from "./market";
import featuresRouter from "./features";
import exchangeRouter from "./exchange";
import minesPassPurchaseGuardRouter from "./minesPassPurchaseGuard";
import minesPassCapRouter from "./minesPassCap";
import minesRouter from "./mines";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usersRouter);
router.use(predictionsRouter);
router.use(questsRouter);
router.use(rewardsRouter);
router.use(withdrawalsRouter);
router.use(gemsRouter);
// Must be mounted before contentRouter to replace/protect old content handlers.
router.use(contentSubmitGuardRouter);
router.use(contentStatusGuardRouter);
router.use(contentRouter);
router.use(crashRouter);
router.use(marketRouter);
router.use(featuresRouter);
router.use(exchangeRouter);
// Must be mounted before Mines routers so pass purchase memo binding and pass-aware
// start/cashout handlers run first.
router.use(minesPassPurchaseGuardRouter);
router.use(minesPassCapRouter);
router.use(minesRouter);

export default router;
