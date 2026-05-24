import { z } from 'zod';

export const contextPackFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  language: z.string().min(1),
});

export const contextPackMetadataSchema = z.object({
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  branch: z.string().min(1),
  totalFiles: z.number().int().nonnegative(),
  truncated: z.boolean(),
  assembledAt: z.string().min(1),
  packId: z.string().regex(/^cp_[a-f0-9]{8}$/),
  packVersion: z.string().min(1),
  profile: z.string().min(1),
  selectedBy: z.string().min(1).nullable(),
});

export const contextPackSchema = z.object({
  files: z.array(contextPackFileSchema),
  metadata: contextPackMetadataSchema,
});

export type ContextPackContract = z.infer<typeof contextPackSchema>;
