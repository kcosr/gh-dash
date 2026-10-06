import type { SegOption } from '../workbench';

export const WHO_OPTIONS: SegOption<'me' | 'others' | 'everyone'>[] = [
  { value: 'me', label: 'Me' },
  { value: 'others', label: 'Others' },
  { value: 'everyone', label: 'Everyone' },
];
