-- 003_quiz: savollar banki, to'plamlar, urinishlar, javoblar (snapshot), ball daftari
CREATE TABLE questions (
  id             serial PRIMARY KEY,
  text           text NOT NULL,
  correct_answer text NOT NULL,
  explanation    text NOT NULL DEFAULT '',
  category       text NOT NULL,
  difficulty     text NOT NULL CHECK (difficulty IN ('EASY','MEDIUM','HARD')),
  points         integer NOT NULL CHECK (points > 0),
  active         boolean NOT NULL DEFAULT true,
  deleted_at     timestamptz,
  created_by     integer REFERENCES admins(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX questions_category_idx ON questions (category, difficulty);

CREATE TABLE question_variants (
  id          serial PRIMARY KEY,
  question_id integer NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  text        text NOT NULL
);
CREATE INDEX question_variants_q_idx ON question_variants (question_id);

CREATE TABLE question_packs (
  id           serial PRIMARY KEY,
  type         text NOT NULL DEFAULT 'MAIN' CHECK (type IN ('MAIN','VERIFICATION')),
  title        text NOT NULL,
  pack_date    date,
  published    boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  created_by   integer REFERENCES admins(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pack_questions (
  pack_id     integer NOT NULL REFERENCES question_packs(id) ON DELETE CASCADE,
  question_id integer NOT NULL REFERENCES questions(id),
  position    integer NOT NULL CHECK (position BETWEEN 1 AND 30),
  PRIMARY KEY (pack_id, question_id),
  CONSTRAINT pack_questions_pos_key UNIQUE (pack_id, position)
);

CREATE TABLE quiz_attempts (
  id                serial PRIMARY KEY,
  user_id           integer NOT NULL REFERENCES users(id),
  pack_id           integer NOT NULL REFERENCES question_packs(id),
  kind              text NOT NULL CHECK (kind IN ('MAIN','REPLAY','VERIFICATION')),
  status            text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','FINISHED')),
  -- MAIN uchun = pack_id, boshqalar uchun NULL: har foydalanuvchi har to'plamni faqat bir marta asosiy urinish qiladi
  main_lock_pack_id integer,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  raw_points        integer NOT NULL DEFAULT 0,
  CONSTRAINT quiz_attempts_main_once UNIQUE (user_id, main_lock_pack_id)
);
CREATE INDEX quiz_attempts_user_idx ON quiz_attempts (user_id, pack_id);

CREATE TABLE quiz_answers (
  id             serial PRIMARY KEY,
  attempt_id     integer NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  position       integer NOT NULL,
  question_id    integer NOT NULL,
  snapshot       jsonb NOT NULL,   -- savol, to'g'ri javob, variantlar, izoh, ball: o'zgarmas
  status         text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','OPEN','CORRECT','WRONG','UNANSWERED','PENDING_REVIEW')),
  opened_at      timestamptz,
  deadline_at    timestamptz,
  submitted_text text,
  answered_at    timestamptz,
  awarded_points integer NOT NULL DEFAULT 0,
  CONSTRAINT quiz_answers_pos_key UNIQUE (attempt_id, position)
);
CREATE INDEX quiz_answers_open_idx ON quiz_answers (status, deadline_at) WHERE status = 'OPEN';

-- Snapshot va yakuniy natija DB darajasida o'zgarmas
CREATE FUNCTION quiz_answers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot THEN
    RAISE EXCEPTION 'quiz_answers.snapshot is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('CORRECT','WRONG','UNANSWERED')
     AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.submitted_text IS DISTINCT FROM OLD.submitted_text
          OR NEW.awarded_points IS DISTINCT FROM OLD.awarded_points) THEN
    RAISE EXCEPTION 'quiz_answers: final result is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quiz_answers_guard_trg BEFORE UPDATE ON quiz_answers FOR EACH ROW EXECUTE FUNCTION quiz_answers_guard();

CREATE TABLE score_ledger (
  id              bigserial PRIMARY KEY,
  user_id         integer NOT NULL REFERENCES users(id),
  amount          integer NOT NULL,
  source          text NOT NULL CHECK (source IN ('QUIZ_MAIN','QUIZ_REPLAY','COMPLAINT_APPROVED','ADMIN_ADJUSTMENT','CHEAT_PENALTY','CHEAT_PENALTY_REFUND','REVIEW_RESOLVED')),
  reason          text NOT NULL,
  ref_type        text,
  ref_id          text,
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX score_ledger_user_idx ON score_ledger (user_id, created_at);
CREATE TRIGGER score_ledger_no_change BEFORE UPDATE OR DELETE ON score_ledger FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER score_ledger_no_truncate BEFORE TRUNCATE ON score_ledger FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Ledger yig'indisi keshi: ledger yozuvi bilan BIR tranzaksiyada yangilanadi
CREATE TABLE user_scores (
  user_id    integer PRIMARY KEY REFERENCES users(id),
  total      integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_scores_total_idx ON user_scores (total DESC);
