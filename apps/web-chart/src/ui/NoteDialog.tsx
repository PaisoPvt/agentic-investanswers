// Asks for a text note's text (UI-01). Save with an empty text, or Cancel on a
// note just placed, removes the note.

import type { FormEvent } from 'react';
import { useState } from 'react';

export interface NoteDialogProps {
  readonly text: string;
  readonly isNew: boolean;
  readonly onSave: (text: string) => void;
  readonly onCancel: () => void;
}

export function NoteDialog({ text, isNew, onSave, onCancel }: NoteDialogProps) {
  const [value, setValue] = useState(text);
  const save = (event: FormEvent) => {
    event.preventDefault();
    onSave(value);
  };
  return (
    <div className="overlay" onClick={onCancel}>
      <form
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-title"
        data-testid="note-dialog"
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      >
        <h2 id="note-title">{isNew ? 'Add a note' : 'Edit note'}</h2>
        <input
          aria-label="Note text"
          data-testid="note-text"
          className="note-input"
          maxLength={200}
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="actions">
          <span />
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" data-testid="note-save">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
