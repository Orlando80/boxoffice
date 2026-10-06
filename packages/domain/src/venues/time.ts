/** Formats a UTC instant in an IANA zone as e.g. "Sat 25 Oct 2026, 19:30". Throws RangeError on a bad date or zone. */
export const formatInZone = (utc: Date, ianaZone: string): string => {
  if (Number.isNaN(utc.getTime())) throw new RangeError("Invalid date");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ianaZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(utc);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}`;
};
