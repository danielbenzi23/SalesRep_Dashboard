#!/usr/bin/env node
// Make a personal dashboard password entry.
//
//   node scripts/hash-password.mjs
//
// Asks for the email and the password and prints one line to add to the
// DASHBOARD_USER_PASSWORDS env var in Vercel, which is a single JSON object:
//   { "a@x.com": "scrypt$...", "b@x.com": "scrypt$..." }
// Only the hash goes into Vercel; the password itself is never stored.
import { scryptSync, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const rl = createInterface({ input: process.stdin, output: process.stderr });
const email = (await rl.question('Email: ')).trim().toLowerCase();
const password = await rl.question('Password (min 10 characters): ');
rl.close();
if (!email || password.length < 10) {
  console.error('Need an email and a password of at least 10 characters.');
  process.exit(1);
}
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32);
console.log(`"${email}": "scrypt$${salt.toString('hex')}$${hash.toString('hex')}"`);
