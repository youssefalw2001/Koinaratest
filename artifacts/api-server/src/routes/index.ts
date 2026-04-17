import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import predictionsRouter from "./predictions";
import questsRouter from "./quests";
import rewardsRouter from "./rewards";
import withdrawalsRouter from "./withdrawals";
import gemsRouter from "./gems";
import contentRouter from "./content";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usersRouter);
router.use(predictionsRouter);
router.use(questsRouter);
router.use(rewardsRouter);
router.use(withdrawalsRouter);
router.use(gemsRouter);
router.use(contentRouter);

export default router;
