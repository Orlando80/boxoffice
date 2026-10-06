export const ACCESS_FEATURES = [
  "wheelchair_space",
  "transfer_seat",
  "step_free",
  "aisle",
  "extra_legroom",
  "hearing_loop",
  "near_exit",
] as const;

export type AccessFeature = (typeof ACCESS_FEATURES)[number];

export const isAccessFeature = (value: string): value is AccessFeature =>
  (ACCESS_FEATURES as readonly string[]).includes(value);
