import { z } from 'zod';
import { MAX_VIEW_RANGES, MAX_VIEW_SELECTION_CHARS } from './api';

const path = z.string().min(1).max(4096);
const ref = z.string().min(1).max(4096);
const oid = z.string().regex(/^[a-f0-9]{7,64}$/i);
const lineNumber = z.int().positive();
const side = z.enum(['old', 'new']);
const startEnd = { startLine: lineNumber, endLine: lineNumber };
const rangeFields = { side, ...startEnd };
const ordered = (range: { startLine: number; endLine: number }) => range.startLine <= range.endLine;

const target = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pr'), repo: ref, number: z.int().positive() }),
  z.strictObject({ kind: z.literal('branch'), repo: ref, branch: ref }),
  z.strictObject({ kind: z.literal('commit'), repo: ref, oid }),
]);

const textRange = z.strictObject({ path, ...rangeFields, text: z.string().min(1).max(MAX_VIEW_SELECTION_CHARS) }).refine(ordered);
const textSelection = z.strictObject({
  kind: z.literal('text'),
  ranges: z.array(textRange).min(1).max(MAX_VIEW_RANGES),
  truncated: z.boolean(),
}).refine((s) => s.ranges.reduce((n, r) => n + r.text.length, 0) <= MAX_VIEW_SELECTION_CHARS);
const lineSelection = z.strictObject({ kind: z.literal('lines'), path, ...rangeFields }).refine(ordered);

const viewport = z.strictObject({
  first: z.strictObject({ side, lineNumber }),
  visible: z.array(z.strictObject(rangeFields).refine(ordered)).max(MAX_VIEW_RANGES),
  hunk: z.strictObject({ oldStart: z.int().nonnegative(), oldCount: z.int().nonnegative(), newStart: z.int().nonnegative(), newCount: z.int().nonnegative() }).nullable(),
});

export const currentViewSchema = z.strictObject({
  mode: z.enum(['details', 'diff']),
  target,
  baseOid: oid.nullable(),
  headOid: oid.nullable(),
  file: z.strictObject({ path, previousPath: path.nullable() }).nullable(),
  viewport: viewport.nullable(),
  selection: z.discriminatedUnion('kind', [textSelection, lineSelection]).nullable(),
  threadId: z.int().positive().nullable(),
});

export const currentViewReplySchema = z.strictObject({
  requestId: z.uuid(),
  focusedAt: z.int().nonnegative(),
  view: currentViewSchema.nullable(),
});

export type CurrentView = z.infer<typeof currentViewSchema>;
export type CurrentViewReply = z.infer<typeof currentViewReplySchema>;
