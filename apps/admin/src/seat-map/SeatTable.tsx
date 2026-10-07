import type { LayoutModel } from "./model";

export function SeatTable({ model }: { model: LayoutModel }) {
  return (
    <>
      {model.sections.map((sec) => {
        const headingId = `section-${sec.id}`;
        if (sec.kind === "ga") {
          return (
            <section key={sec.id} aria-labelledby={headingId}>
              <h2 id={headingId}>{sec.name}</h2>
              <p>
                General admission, capacity {sec.capacity}
                {model.showHeld ? `, ${sec.held} of ${sec.capacity} held` : ""}.
              </p>
            </section>
          );
        }
        return (
          <section key={sec.id} aria-labelledby={headingId}>
            <h2 id={headingId}>{sec.name}</h2>
            <div
              className="table-wrap"
              role="region"
              tabIndex={0}
              aria-label={`${sec.name} seat table`}
            >
              <table>
                <caption>
                  {sec.name}: {sec.seats.length} {sec.seats.length === 1 ? "seat" : "seats"}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Seat</th>
                    <th scope="col">Access features</th>
                    <th scope="col">Companion</th>
                    {model.showHeld && <th scope="col">Status</th>}
                  </tr>
                </thead>
                <tbody>
                  {sec.seats.map((seat) => (
                    <tr key={seat.id} data-seat-id={seat.id}>
                      <td>{seat.rowLabel}</td>
                      <td>{seat.seatLabel}</td>
                      <td>
                        {seat.featureText.length === 0 ? "None" : seat.featureText.join(", ")}
                      </td>
                      <td>
                        {[
                          ...seat.companionFor.map((l) => `Companion for ${l}`),
                          ...seat.companions.map((l) => `Has companion ${l}`),
                        ].join("; ") || "None"}
                      </td>
                      {model.showHeld && <td>{seat.held ? "Held" : "Available"}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}
