import { AnimatePresence, motion } from "framer-motion";

interface ConfettiBurstProps {
  active: boolean;
  count?: number;
  onComplete?: () => void;
}

const COLORS = ["#FFD700", "#00E676", "#FF1744", "#4DA3FF", "#B388FF"];

export function ConfettiBurst({ active, count = 70, onComplete }: ConfettiBurstProps) {
  const particles = Array.from({ length: count }, (_, i) => {
    const angle = Math.random() * Math.PI * 2;
    const distance = 80 + Math.random() * 180;
    const x = Math.cos(angle) * distance;
    const y = Math.sin(angle) * distance - 40;
    return {
      id: i,
      x,
      y,
      rotate: (Math.random() - 0.5) * 540,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      delay: Math.random() * 0.14,
    };
  });

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          className="pointer-events-none absolute inset-0 z-[130] overflow-hidden"
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {particles.map((p, idx) => (
            <motion.span
              key={p.id}
              className="absolute left-1/2 top-1/2 h-2.5 w-1.5 rounded-sm"
              style={{ background: p.color, boxShadow: `0 0 10px ${p.color}` }}
              initial={{ x: 0, y: 0, rotate: 0, opacity: 1, scale: 0.9 }}
              animate={{ x: p.x, y: p.y, rotate: p.rotate, opacity: 0, scale: 1.2 }}
              transition={{ duration: 0.92, ease: "easeOut", delay: p.delay }}
              onAnimationComplete={idx === 0 ? onComplete : undefined}
            />
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
