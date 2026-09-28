import React, { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  vx: number;
  vy: number;
  rotation: number;
  vRot: number;
  opacity: number;
}

const COLORS = [
  "#f43f5e",
  "#ec4899",
  "#8b5cf6",
  "#6366f1",
  "#06b6d4",
  "#10b981",
  "#facc15",
  "#fb923c",
];

export const triggerGlobalConfetti = () => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("skribbl-trigger-confetti"));
  }
};

export const Confetti: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let animId: number;
    let particles: Particle[] = [];

    const handleTrigger = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;

      const numParticles = 80;
      const newParticles: Particle[] = [];

      for (let i = 0; i < numParticles; i++) {
        newParticles.push({
          x: canvas.width / 2 + (Math.random() - 0.5) * (canvas.width * 0.4),
          y: Math.random() * (canvas.height * 0.25),
          w: Math.random() * 8 + 6,
          h: Math.random() * 12 + 6,
          color: COLORS[Math.floor(Math.random() * COLORS.length)],
          vx: (Math.random() - 0.5) * 8,
          vy: Math.random() * 4 + 3,
          rotation: Math.random() * 360,
          vRot: (Math.random() - 0.5) * 10,
          opacity: 1,
        });
      }

      particles = [...particles, ...newParticles];

      if (!animId) {
        loop();
      }
    };

    const loop = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.vRot;
        p.vy += 0.12; // gravity
        p.vx *= 0.99; // air drag

        if (p.y > canvas.height * 0.7) {
          p.opacity -= 0.02;
        }

        ctx.save();
        ctx.globalAlpha = Math.max(0, p.opacity);
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }

      particles = particles.filter((p) => p.opacity > 0 && p.y < canvas.height + 50);

      if (particles.length > 0) {
        animId = requestAnimationFrame(loop);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        animId = 0;
      }
    };

    window.addEventListener("skribbl-trigger-confetti", handleTrigger);
    return () => {
      window.removeEventListener("skribbl-trigger-confetti", handleTrigger);
      if (animId) cancelAnimationFrame(animId);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="confetti-canvas-overlay"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        pointerEvents: "none",
        zIndex: 9999,
      }}
    />
  );
};
