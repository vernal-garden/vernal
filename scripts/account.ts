import dotenv from 'dotenv';
import readline from 'readline';
import { Writable } from 'stream';
import { Pool } from 'pg';
import { ConfigError, loadServerConfig } from '../src/lib/serverConfig';
import {
  USAGE,
  parseArgs,
  setEmail,
  setPassword,
  setRole,
  type Command,
} from '../src/lib/accountAdmin';

dotenv.config();

// Operator-side account fixes: npm run account -- <command>. See USAGE.

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`${parsed.error}\n\n${USAGE}`);
  process.exit(1);
}

try {
  loadServerConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

// Reads one line with the typed characters hidden.
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let muted = false;
    const output = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) process.stdout.write(chunk, encoding);
        callback();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
    let answered = false;
    rl.on('close', () => {
      if (!answered) reject(new Error('Cancelled.'));
    });
    process.stdout.write(question);
    muted = true;
    rl.question('', (answer) => {
      answered = true;
      muted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

type Outcome = { ok: true; message: string } | { ok: false; error: string };

async function main(command: Command): Promise<Outcome> {
  let password = '';
  if (command.kind === 'set-password') {
    if (!process.stdin.isTTY) {
      return { ok: false, error: 'set-password needs an interactive terminal.' };
    }
    password = await promptHidden('New password: ');
    const again = await promptHidden('Repeat password: ');
    if (password !== again) return { ok: false, error: 'The passwords did not match.' };
  }

  if (!process.env.DATABASE_URL) return { ok: false, error: 'DATABASE_URL is not set.' };
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  try {
    switch (command.kind) {
      case 'set-password': {
        const result = await setPassword(client, command.email, password);
        return result.ok ? { ok: true, message: `Password updated for ${command.email}.` } : result;
      }
      case 'set-email': {
        const result = await setEmail(client, command.current, command.next);
        return result.ok ? { ok: true, message: `Email changed to ${command.next}.` } : result;
      }
      case 'set-role': {
        const result = await setRole(client, command.email, command.role);
        return result.ok ? { ok: true, message: `${command.email} is now ${command.role}.` } : result;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main(parsed.command)
  .then((result) => {
    if (result.ok) {
      console.log(result.message);
      process.exit(0);
    }
    console.error(result.error);
    process.exit(1);
  })
  .catch((err: unknown) => {
    console.error(`Failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exit(1);
  });
