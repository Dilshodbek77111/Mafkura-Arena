-- 004: yakunlangan javobning barcha identifikator va vaqt maydonlarini ham o'zgarmas qilish
CREATE OR REPLACE FUNCTION quiz_answers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot THEN
    RAISE EXCEPTION 'quiz_answers.snapshot is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('CORRECT','WRONG','UNANSWERED')
     AND (NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
          OR NEW.position IS DISTINCT FROM OLD.position
          OR NEW.question_id IS DISTINCT FROM OLD.question_id
          OR NEW.status IS DISTINCT FROM OLD.status
          OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
          OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
          OR NEW.submitted_text IS DISTINCT FROM OLD.submitted_text
          OR NEW.answered_at IS DISTINCT FROM OLD.answered_at
          OR NEW.awarded_points IS DISTINCT FROM OLD.awarded_points) THEN
    RAISE EXCEPTION 'quiz_answers: final result is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
