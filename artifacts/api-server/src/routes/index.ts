import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import predictionsRouter from "./predictions";
import questsRouter from "./quests";
import rewardsRouter from "./rewards";
import withdrawalsRouter from "./withdrawals";
import gemsRouter from "./gems";
import contentRouter from "./content";
import crashRouter from "./crash";
import marketRouter from "./market";
import featuresRouter from "./features";
import exchangeRouter from "./exchange";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usersRouter);
router.use(predictionsRouter);
router.use(questsRouter);
router.use(rewardsRouter);
router.use(withdrawalsRouter);
router.use(gemsRouter);
router.use(contentRouter);
router.use(crashRouter);
router.use(marketRouter);
router.use(featuresRouter);
router.use(exchangeRouter);

export default router;
