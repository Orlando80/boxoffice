import { z } from "zod";

export const HealthResponse = z.object({ status: z.literal("ok") }).strict();

export type HealthResponse = z.infer<typeof HealthResponse>;
