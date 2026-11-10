-- Keep learners' video progress from before "complete only when watched" (migration 005).
-- Lessons already completed stay completed: completed_at is never cleared.
-- Learners part-way through a video get credit for where they had reached, so they don't start again from zero.
-- (Rows the new player has reported on have last_report_at set and are left alone.)
UPDATE lesson_progress
   SET watched_sec = position_sec
 WHERE last_report_at IS NULL
   AND completed_at IS NULL
   AND position_sec > 0
   AND watched_sec < position_sec;
