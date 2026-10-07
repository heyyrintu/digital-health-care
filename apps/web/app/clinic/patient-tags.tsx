'use client';

import type { Tag, TagRef } from '@dhc/contracts';
import { TagChip } from './patient-bits';
import { useSession } from './session-provider';

/**
 * Tag checkboxes. Archived tags are offered only if already on the patient, so they
 * can be removed but not newly assigned.
 */
export function TagPicker({
  tags,
  selected,
  onChange,
}: {
  tags: Tag[];
  selected: string[];
  onChange(ids: string[]): void;
}) {
  const { t } = useSession();
  const shown = tags.filter((tag) => !tag.archived || selected.includes(tag.id));
  if (shown.length === 0) return null;
  return (
    <fieldset className="field wide tag-picker">
      <legend>{t('patient.tags')}</legend>
      {shown.map((tag) => (
        <label key={tag.id} className="checkbox">
          <input
            type="checkbox"
            checked={selected.includes(tag.id)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...selected, tag.id] : selected.filter((id) => id !== tag.id),
              )
            }
          />
          <TagChip tag={tag} />
        </label>
      ))}
    </fieldset>
  );
}

export function TagList({ tags }: { tags: TagRef[] }) {
  const { t } = useSession();
  if (tags.length === 0) return <span className="hint">{t('patient.noTags')}</span>;
  return (
    <span className="tags">
      {tags.map((tag) => (
        <TagChip key={tag.id} tag={tag} />
      ))}
    </span>
  );
}
