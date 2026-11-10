-- Learners see the score of their latest quiz attempt (not their best one).
ALTER TABLE quiz_states ADD COLUMN last_score numeric(5, 2);

UPDATE quiz_states s SET last_score = a.score
  FROM (SELECT DISTINCT ON (enrollment_id, quiz_id) enrollment_id, quiz_id, score
          FROM quiz_attempts ORDER BY enrollment_id, quiz_id, created_at DESC) a
 WHERE a.enrollment_id = s.enrollment_id AND a.quiz_id = s.quiz_id;
