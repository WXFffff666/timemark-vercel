-- Migration: Add new columns to events table for personName, birthDate, etc.
-- Run this SQL to update existing database

ALTER TABLE events ADD COLUMN IF NOT EXISTS person_name VARCHAR(100);
ALTER TABLE events ADD COLUMN IF NOT EXISTS birth_date VARCHAR(50);
ALTER TABLE events ADD COLUMN IF NOT EXISTS birth_date_lunar VARCHAR(50);
ALTER TABLE events ADD COLUMN IF NOT EXISTS reminder_recipient_name VARCHAR(100);
ALTER TABLE events ADD COLUMN IF NOT EXISTS reminder_recipient_email VARCHAR(255);
