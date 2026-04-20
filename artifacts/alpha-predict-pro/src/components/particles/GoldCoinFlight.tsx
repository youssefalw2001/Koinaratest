import { motion } from "framer-motion";

interface GoldCoinFlightProps {
  id: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  onDone?: () => void;
}

export function GoldCoinFlight({
  id,
  startX,
  startY,
  endX,
  endY,
  onDone,
}: GoldCoinFlightProps) {
  const dx = endX - startX;
  const dy = endY - startY;
  const controlY = dy - 120;

  return (
    <motion.div
      key={id}
      className="pointer-events-none fixed left-0 top-0 z-[120]"
      initial={{ x: startX, y: startY, scale: 0.8, opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        initial={{ x: 0, y: 0 }}
        animate={{ x: dx, y: dy }}
        transition={{ duration: 1.05, ease: [0.2, 0.8, 0.18, 1] }}
        onAnimationComplete={onDone}
      >
        <motion.div
          initial={{ y: 0, rotate: 0, scale: 0.9 }}
          animate={{ y: [0, controlY, 0], rotate: [0, 160, 320], scale: [0.9, 1.05, 0.78] }}
          transition={{ duration: 1.05, ease: "easeInOut", times: [0, 0.5, 1] }}
          className="flex h-6 w-6 items-center justify-center rounded-full border border-[#FFD700]/70 bg-[#FFD700]/25 text-[11px] shadow-[0_0_14px_rgba(255,215,0,0.55)]"
        >
          🟡
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
