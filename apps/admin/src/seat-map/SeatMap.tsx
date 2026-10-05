import {
  buildModel,
  seatTitle,
  SCALE,
  type LayoutModel,
  type Marker,
  type SeatModel,
} from "./model";
import { ZoomFrame } from "./ZoomFrame";

export { buildModel };

const GLYPH: Record<Marker, string> = { plain: "", wheelchair: "W", companion: "C", access: "A" };

const LEGEND: { marker: Marker; text: string }[] = [
  { marker: "plain", text: "Standard seat (circle)" },
  { marker: "wheelchair", text: "Wheelchair space (square, W)" },
  { marker: "companion", text: "Companion seat (diamond, C)" },
  { marker: "access", text: "Other access feature (triangle, A)" },
];

/** The outline for one marker, centred on (cx, cy), in svg user units. */
function Shape({ marker, cx, cy }: { marker: Marker; cx: number; cy: number }) {
  switch (marker) {
    case "wheelchair":
      return <rect x={cx - 4} y={cy - 4} width={8} height={8} />;
    case "companion":
      return (
        <polygon
          points={`${cx},${cy - 4.5} ${cx + 4.5},${cy} ${cx},${cy + 4.5} ${cx - 4.5},${cy}`}
        />
      );
    case "access":
      return (
        <polygon points={`${cx},${cy - 4.5} ${cx + 4.5},${cy + 3.5} ${cx - 4.5},${cy + 3.5}`} />
      );
    default:
      return <circle cx={cx} cy={cy} r={3} />;
  }
}

function Seat({ seat }: { seat: SeatModel }) {
  const cx = seat.x * SCALE;
  const cy = seat.y * SCALE;
  return (
    <g
      className={`seat seat-${seat.marker}`}
      data-seat-id={seat.id}
      data-features={seat.features.join(" ")}
      data-marker={seat.marker}
    >
      <title>{seatTitle(seat)}</title>
      <Shape marker={seat.marker} cx={cx} cy={cy} />
      {seat.marker !== "plain" && (
        <text x={cx} y={cy + 2} textAnchor="middle" fontSize={5.5} fontWeight={700}>
          {GLYPH[seat.marker]}
        </text>
      )}
    </g>
  );
}

function Legend() {
  return (
    <>
      <h2>Seat map key</h2>
      <ul className="seatmap-legend">
        {LEGEND.map(({ marker, text }) => (
          <li key={marker}>
            <svg
              width={24}
              height={24}
              viewBox="-12 -12 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <g className={`seat seat-${marker}`} transform="scale(2)">
                <Shape marker={marker} cx={0} cy={0} />
                {marker !== "plain" && (
                  <text x={0} y={2} textAnchor="middle" fontSize={5.5} fontWeight={700}>
                    {GLYPH[marker]}
                  </text>
                )}
              </g>
            </svg>
            <span>{text}</span>
          </li>
        ))}
        <li>
          <svg width={24} height={24} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect className="ga-area" x={2} y={6} width={20} height={12} />
          </svg>
          <span>General admission area (labelled rectangle with capacity)</span>
        </li>
      </ul>
    </>
  );
}

/** Server component: seats render as plain SVG; only ZoomFrame is a client component. */
export function SeatMap({ model }: { model: LayoutModel }) {
  return (
    <figure className="seatmap">
      <figcaption>
        <strong>Seat map: {model.name}</strong>
      </figcaption>
      <ZoomFrame
        bounds={model.bounds}
        label={`${model.summary}. Full details in the seat table below.`}
      >
        {model.sections.map((sec) =>
          sec.kind === "ga" ? (
            <g key={sec.id} className="ga" data-ga-id={sec.id}>
              <title>{`${sec.name}, general admission, capacity ${sec.capacity}`}</title>
              <rect
                className="ga-area"
                x={sec.x * SCALE}
                y={sec.y * SCALE}
                width={sec.width * SCALE}
                height={sec.height * SCALE}
              />
              <text
                x={(sec.x + sec.width / 2) * SCALE}
                y={(sec.y + sec.height / 2) * SCALE + 2}
                textAnchor="middle"
                fontSize={7}
              >
                {`${sec.name} - capacity ${sec.capacity}`}
              </text>
            </g>
          ) : (
            <g key={sec.id} className="section" data-section-id={sec.id}>
              {sec.seats.map((seat) => (
                <Seat key={seat.id} seat={seat} />
              ))}
            </g>
          ),
        )}
      </ZoomFrame>
      <Legend />
    </figure>
  );
}
