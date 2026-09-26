-- Run this once to create the NaijaBridge database and app user.
-- Usage (from a terminal, will prompt for the postgres superuser password):
--   "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -f scripts\setup-db.sql

CREATE USER naijabridge_app WITH PASSWORD 'naijabridge_dev_local';
CREATE DATABASE naijabridge OWNER naijabridge_app;
