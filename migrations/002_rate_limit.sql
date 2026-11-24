-- 002: DB-asosidagi rate limit (ko'p nusxali serverda ham to'g'ri ishlaydi)
CREATE TABLE rate_limits (
  key          text        NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX rate_limits_window_idx ON rate_limits (window_start);
