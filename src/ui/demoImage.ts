/**
 * A procedurally generated image, so the app is playable the moment it loads without
 * the user having to find a photograph first. Also gives the piece-count benchmarks a
 * fixed, dependency-free subject.
 */

import { makeRng } from '../engine/rng.js';

export function makeDemoImage(width = 1600, height = 1100, seed = 20260901): Blob | HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const rng = makeRng(seed);

  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#1b3a63');
  sky.addColorStop(0.45, '#4a7fb5');
  sky.addColorStop(0.62, '#e8b98a');
  sky.addColorStop(1, '#7a4a3c');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  // Sun.
  const sunX = width * 0.68;
  const sunY = height * 0.55;
  const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, height * 0.42);
  glow.addColorStop(0, 'rgba(255,240,200,0.95)');
  glow.addColorStop(0.25, 'rgba(255,190,120,0.45)');
  glow.addColorStop(1, 'rgba(255,160,90,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // Layered hills, back to front.
  const layers = [
    { y: 0.6, amp: 0.045, colour: '#2c4a63' },
    { y: 0.68, amp: 0.06, colour: '#24384d' },
    { y: 0.78, amp: 0.05, colour: '#1a2a3a' },
  ];
  for (const layer of layers) {
    ctx.beginPath();
    ctx.moveTo(0, height);
    const phase = rng() * Math.PI * 2;
    const freq = 1.4 + rng() * 1.8;
    for (let x = 0; x <= width; x += 6) {
      const t = x / width;
      const y =
        height * layer.y +
        Math.sin(t * Math.PI * freq + phase) * height * layer.amp +
        Math.sin(t * Math.PI * freq * 2.7 + phase * 1.7) * height * layer.amp * 0.35;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = layer.colour;
    ctx.fill();
  }

  // Scattered detail so pieces from different regions are distinguishable.
  for (let i = 0; i < 220; i++) {
    const x = rng() * width;
    const y = height * (0.05 + rng() * 0.5);
    const r = 1 + rng() * 2.2;
    ctx.fillStyle = `rgba(255,255,255,${0.15 + rng() * 0.5})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  for (let i = 0; i < 60; i++) {
    const x = rng() * width;
    const baseY = height * (0.8 + rng() * 0.18);
    const h = height * (0.04 + rng() * 0.09);
    ctx.fillStyle = `rgba(10,18,24,${0.55 + rng() * 0.35})`;
    ctx.beginPath();
    ctx.moveTo(x, baseY);
    ctx.lineTo(x - h * 0.22, baseY);
    ctx.lineTo(x, baseY - h);
    ctx.lineTo(x + h * 0.22, baseY);
    ctx.closePath();
    ctx.fill();
  }

  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('could not encode image'));
    }, 'image/webp', 0.92);
  });
}
