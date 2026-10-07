import { z } from 'zod';

const Colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** A tag as shown on a patient (colour chip). */
export const TagRef = z.object({
  id: z.uuid(),
  name: z.string(),
  colour: z.string(),
  sortToTop: z.boolean(),
});
export type TagRef = z.infer<typeof TagRef>;

export const Tag = TagRef.extend({
  /** Archived tags stay on past patients but can no longer be assigned. */
  archived: z.boolean(),
});
export type Tag = z.infer<typeof Tag>;

export const TagList = z.object({ data: z.array(Tag) });
export type TagList = z.infer<typeof TagList>;

export const CreateTagBody = z.object({
  name: z.string().trim().min(1).max(40),
  colour: Colour,
  sortToTop: z.boolean().default(false),
});
export type CreateTagBody = z.infer<typeof CreateTagBody>;

export const UpdateTagBody = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  colour: Colour.optional(),
  sortToTop: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export type UpdateTagBody = z.infer<typeof UpdateTagBody>;

/** PRD §5.4 defaults, offered to a clinic that has no tags yet. */
export const DEFAULT_TAGS: readonly CreateTagBody[] = [
  { name: 'Emergency', colour: '#b91c1c', sortToTop: true },
  { name: 'Priority', colour: '#c2410c', sortToTop: true },
  { name: '2nd opinion', colour: '#6d28d9', sortToTop: false },
  { name: 'VIP', colour: '#a16207', sortToTop: false },
  { name: 'Insurance', colour: '#1d4ed8', sortToTop: false },
  { name: 'Complaint', colour: '#be185d', sortToTop: false },
];
