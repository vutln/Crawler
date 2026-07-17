-- One-time database bootstrap.
--
-- BEFORE RUNNING: replace CHANGE_ME below with a password you generate, and put
-- the same value in backend/.env (DATABASE_URL and TEST_DATABASE_URL).
--
--   openssl rand -base64 24
--   # or on Windows PowerShell:
--   # -join ((1..24) | % { 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray() | Get-Random })
--
-- Then:  mysql -u root -p < prisma/init-db.sql
--
-- This file is committed, so it must never contain a real password.

CREATE DATABASE IF NOT EXISTS `crawler`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE DATABASE IF NOT EXISTS `crawler_test`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- utf8mb4 is not optional: product titles from these marketplaces routinely
-- contain emoji and CJK, which utf8mb3 truncates mid-title.

CREATE USER IF NOT EXISTS 'crawler'@'localhost'
  IDENTIFIED BY 'CHANGE_ME';

GRANT ALL PRIVILEGES ON `crawler`.*      TO 'crawler'@'localhost';
GRANT ALL PRIVILEGES ON `crawler_test`.* TO 'crawler'@'localhost';

-- Prisma Migrate creates and drops a shadow database during `migrate dev`.
-- Without this it fails with P3014 and an unhelpful message.
--
-- INDEX is required and is easy to miss: the grant above only covers `crawler`.*,
-- while the shadow database gets a random name and so is only covered by this
-- *.* grant. Every migration is replayed against the shadow first, so without
-- INDEX here, any migration that adds an index to an EXISTING table dies with
-- "INDEX command denied to user 'crawler'@'localhost'" — pointing at a table in a
-- database you never created and cannot see. The initial migration hides the
-- problem, because indexes declared inside CREATE TABLE need no INDEX privilege.
GRANT CREATE, DROP, ALTER, REFERENCES, INDEX ON *.* TO 'crawler'@'localhost';

FLUSH PRIVILEGES;

SELECT VERSION() AS mysql_version, 'bootstrap complete' AS status;
