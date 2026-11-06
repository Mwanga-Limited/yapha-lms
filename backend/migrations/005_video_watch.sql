-- Video lessons complete only when the learner has actually watched them.
-- The player reports its position every few seconds; the server counts a stretch as watched only if
-- the real time between two reports could cover it (so skipping ahead to the end doesn't count).
ALTER TABLE lesson_progress
  ADD COLUMN watched_sec    numeric(10, 2) NOT NULL DEFAULT 0,   -- seconds of video actually played
  ADD COLUMN duration_sec   numeric(10, 2) NOT NULL DEFAULT 0,   -- the video's length, as the player reports it
  ADD COLUMN last_report_at timestamptz;                         -- when the player last reported its position
