-- Removes the unused lowercase 'naijabridge' database/user created earlier
-- in this session, now that the backend uses 'NaijaBridge' via postgres superuser.
DROP DATABASE IF EXISTS naijabridge;
DROP USER IF EXISTS naijabridge_app;
