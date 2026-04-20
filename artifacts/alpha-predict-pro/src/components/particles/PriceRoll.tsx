import { AnimatePresence, motion } from "framer-motion";

interface PriceRollProps {
  value: number;
  color: string;
}

export function PriceRoll({ value, color }: PriceRollProps) {
  const formatted = value > 0
    ? `$${value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
    : "CONNECTING...";

  return (
    <div className="relative h-[52px] overflow-hidden">
      <AnimatePresence mode="wait">
        <motion.div
          key={formatted}
          initial={{ y: 40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -40, opacity: 0 }}
          transition={{ duration: 0.28, ease: "easeOut" }}
          className="font-mono text-[42px] font-black tracking-tight tabular-nums"
          style={{ color, filter: `drop-shadow(0 0 14px ${color})` }}
        >
          {formatted}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
