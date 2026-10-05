"use client";

import { useId, useState, type ReactNode } from "react";

type Bounds = { x: number; y: number; width: number; height: number };

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.5;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Zoom state only. The seats arrive as server-rendered children. */
export function ZoomFrame({
  bounds,
  label,
  children,
}: {
  bounds: Bounds;
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  const [zoom, setZoom] = useState(1);
  const [centre, setCentre] = useState({
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  });

  const w = bounds.width / zoom;
  const h = bounds.height / zoom;
  const clamp = (c: { x: number; y: number }, z: number) => ({
    x: Math.min(
      Math.max(c.x, bounds.x + bounds.width / z / 2),
      bounds.x + bounds.width - bounds.width / z / 2,
    ),
    y: Math.min(
      Math.max(c.y, bounds.y + bounds.height / z / 2),
      bounds.y + bounds.height - bounds.height / z / 2,
    ),
  });
  const viewBox = `${round(centre.x - w / 2)} ${round(centre.y - h / 2)} ${round(w)} ${round(h)}`;

  const zoomTo = (z: number) => {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    setZoom(next);
    setCentre((c) => clamp(c, next));
  };
  const pan = (dx: number, dy: number) =>
    setCentre((c) => clamp({ x: c.x + dx * w * 0.25, y: c.y + dy * h * 0.25 }, zoom));
  const reset = () => {
    setZoom(1);
    setCentre({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
  };

  return (
    <>
      <div className="seatmap-controls" role="group" aria-label="Seat map view controls">
        <button
          type="button"
          aria-controls={id}
          onClick={() => zoomTo(zoom * ZOOM_STEP)}
          disabled={zoom >= MAX_ZOOM}
        >
          Zoom in
        </button>
        <button
          type="button"
          aria-controls={id}
          onClick={() => zoomTo(zoom / ZOOM_STEP)}
          disabled={zoom <= MIN_ZOOM}
        >
          Zoom out
        </button>
        <button type="button" aria-controls={id} onClick={reset} disabled={zoom === 1}>
          Reset
        </button>
        <button type="button" aria-controls={id} onClick={() => pan(-1, 0)} disabled={zoom === 1}>
          Pan left
        </button>
        <button type="button" aria-controls={id} onClick={() => pan(1, 0)} disabled={zoom === 1}>
          Pan right
        </button>
        <button type="button" aria-controls={id} onClick={() => pan(0, -1)} disabled={zoom === 1}>
          Pan up
        </button>
        <button type="button" aria-controls={id} onClick={() => pan(0, 1)} disabled={zoom === 1}>
          Pan down
        </button>
        <span role="status">Zoom {Math.round(zoom * 100)}%</span>
      </div>
      <svg
        id={id}
        className="seatmap-svg"
        role="img"
        aria-label={label}
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
      >
        {children}
      </svg>
    </>
  );
}
