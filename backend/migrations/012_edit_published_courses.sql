-- Editing a published course: changes to its details (title, summary, description, outline, category, level, language,
-- thumbnail) are held on the revision, like lesson changes, and only reach learners when an Admin approves the revision.
-- NULL = the revision doesn't change the details. Otherwise: the full set of details the revision will apply.
ALTER TABLE course_versions ADD COLUMN IF NOT EXISTS meta jsonb;
