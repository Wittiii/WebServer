import { number, formatAxisTime, roundedRect } from "./energy-utils.js";

export function drawPowerChart(canvas, emptyElement, entries, averageKey, peakKey, color, fillColor, period) {
  if (!canvas) return;
  const points = entries.filter((entry) => Number.isFinite(Number(entry[averageKey])));
  if (emptyElement) emptyElement.hidden = points.length > 1;

  const width = Math.max(320, canvas.clientWidth);
  const height = Math.max(260, canvas.clientHeight);
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  if (points.length < 2) return;

  const padding = { top: 25, right: 22, bottom: 45, left: 58 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxPower = Math.max(10, ...points.map((entry) => Number(entry[peakKey] || entry[averageKey])));
  const chartMax = Math.ceil(maxPower / 10) * 10;

  context.font = "12px IBM Plex Sans, sans-serif";
  context.textBaseline = "middle";
  for (let index = 0; index <= 4; index += 1) {
    const y = padding.top + (plotHeight / 4) * index;
    const value = chartMax - (chartMax / 4) * index;
    context.strokeStyle = "rgba(145, 167, 197, 0.14)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.fillStyle = "#91a7c5";
    context.textAlign = "right";
    context.fillText(`${number(value, 0)} W`, padding.left - 10, y);
  }

  const xFor = (index) => padding.left + (index / (points.length - 1)) * plotWidth;
  const yFor = (value) => padding.top + plotHeight - (Number(value) / chartMax) * plotHeight;
  const gradient = context.createLinearGradient(0, padding.top, 0, padding.top + plotHeight);
  gradient.addColorStop(0, fillColor);
  gradient.addColorStop(1, "rgba(4, 10, 19, 0.01)");

  context.beginPath();
  points.forEach((entry, index) => {
    const x = xFor(index);
    const y = yFor(entry[averageKey]);
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.lineTo(xFor(points.length - 1), padding.top + plotHeight);
  context.lineTo(xFor(0), padding.top + plotHeight);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  points.forEach((entry, index) => {
    const x = xFor(index);
    const y = yFor(entry[averageKey]);
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.strokeStyle = color;
  context.lineWidth = 3;
  context.lineJoin = "round";
  context.stroke();

  context.fillStyle = "#ff7f7f";
  points.forEach((entry, index) => {
    const average = Number(entry[averageKey]);
    const peak = Number(entry[peakKey]);
    if (!Number.isFinite(peak) || peak <= average) return;
    const x = xFor(index);
    const y = yFor(peak);
    roundedRect(context, x - 1.5, y - 1.5, 3, Math.max(3, yFor(average) - y), 2);
  });

  const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  context.fillStyle = "#91a7c5";
  context.textBaseline = "top";
  labelIndexes.forEach((pointIndex, index) => {
    context.textAlign = index === 0 ? "left" : index === labelIndexes.length - 1 ? "right" : "center";
    context.fillText(formatAxisTime(points[pointIndex].timestamp, period), xFor(pointIndex), height - padding.bottom + 14);
  });
}
