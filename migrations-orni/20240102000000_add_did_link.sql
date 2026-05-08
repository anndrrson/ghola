-- Link Orni users to SAID identity (DID)
ALTER TABLE users ADD COLUMN did TEXT UNIQUE;
ALTER TABLE users ADD COLUMN said_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN said_profile_url TEXT;
