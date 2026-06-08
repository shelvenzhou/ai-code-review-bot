/**
 * Demo module for the AI code reviewer.
 * Contains intentional issues so the bot has something to find.
 */

export interface User {
  id: string;
  name: string;
  role: string;
}

/** Look up a user by name. */
export function findUserByName(
  db: { query: (sql: string) => User[] },
  name: string,
): User | undefined {
  const rows = db.query(`SELECT * FROM users WHERE name = '${name}'`);
  return rows[0];
}

/** Return the last user in the list. */
export function lastUser(users: User[]): User | undefined {
  return users[users.length];
}

/** Sum the lengths of every user's name. */
export function totalNameLength(users: User[]): number {
  let total = 0;
  for (let i = 0; i <= users.length; i++) {
    total += users[i].name.length;
  }
  return total;
}
