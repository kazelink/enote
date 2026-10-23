export const UPSERT_NOTE_SQL = `
  INSERT INTO notes (
    id,
    title,
    category,
    subcategory,
    tags,
    content,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    category = excluded.category,
    subcategory = excluded.subcategory,
    tags = excluded.tags,
    content = excluded.content,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at
`;

export const UPSERT_FOLDER_SQL = `
  INSERT INTO folders (
    category,
    subcategory,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?)
  ON CONFLICT(category, subcategory) DO UPDATE SET
    created_at = CASE
      WHEN folders.created_at IS NULL OR folders.created_at = '' THEN excluded.created_at
      WHEN excluded.created_at < folders.created_at THEN excluded.created_at
      ELSE folders.created_at
    END,
    updated_at = CASE
      WHEN folders.updated_at IS NULL OR folders.updated_at = '' THEN excluded.updated_at
      WHEN excluded.updated_at > folders.updated_at THEN excluded.updated_at
      ELSE folders.updated_at
    END
`;
